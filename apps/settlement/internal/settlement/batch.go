package settlement

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/balances"
	"github.com/filspay/settlement/internal/money"
	"github.com/filspay/settlement/internal/splits"
)

// ErrMerchantNotEligible is returned by CloseBatch when the merchant is
// not active/non-test-mode at the time of the call.
var ErrMerchantNotEligible = errors.New("settlement: merchant not found or not eligible for settlement")

// BatchResult is CloseBatch's return value.
type BatchResult struct {
	BatchID       uuid.UUID
	MerchantID    uuid.UUID
	BatchDate     time.Time
	AlreadyClosed bool
	GrossFils     money.Fils
	FeeFils       money.Fils
	NetPayoutFils money.Fils
	EventCount    int
	LineCount     int
}

// PayoutResult is PayoutBatch's return value.
type PayoutResult struct {
	BatchID       uuid.UUID
	MerchantID    uuid.UUID
	AlreadyPaid   bool
	NotClosed     bool
	NetPayoutFils money.Fils
}

type eligibleEvent struct {
	id            int64
	transactionID uuid.UUID
	amountFils    money.Fils
	occurredAt    time.Time
}

func CloseBatch(ctx context.Context, db *pgxpool.Pool, merchantID uuid.UUID, businessDate time.Time) (BatchResult, error) {
	start, end := BusinessDayWindow(businessDate)
	batchDateOnly := time.Date(businessDate.Year(), businessDate.Month(), businessDate.Day(), 0, 0, 0, 0, time.UTC)

	tx, err := db.Begin(ctx)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	_, err = tx.Exec(ctx, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status)
		VALUES ($1, $2, 'open')
		ON CONFLICT (merchant_id, batch_date) DO NOTHING
	`, merchantID, batchDateOnly)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: insert batch: %w", err)
	}

	var batchID uuid.UUID
	var status string
	err = tx.QueryRow(ctx, `
		SELECT id, status FROM settlement_batches
		 WHERE merchant_id = $1 AND batch_date = $2
		 FOR UPDATE
	`, merchantID, batchDateOnly).Scan(&batchID, &status)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: lock batch: %w", err)
	}

	if status != "open" {
		tx.Rollback(ctx) //nolint:errcheck
		var gross, fee, net int64
		err = db.QueryRow(ctx, `
			SELECT gross_fils, fee_fils, net_payout_fils FROM settlement_batches WHERE id = $1
		`, batchID).Scan(&gross, &fee, &net)
		if err != nil {
			return BatchResult{}, fmt.Errorf("settlement: CloseBatch: read already-closed batch: %w", err)
		}
		return BatchResult{
			BatchID:       batchID,
			MerchantID:    merchantID,
			BatchDate:     batchDateOnly,
			AlreadyClosed: true,
			GrossFils:     money.Fils(gross),
			FeeFils:       money.Fils(fee),
			NetPayoutFils: money.Fils(net),
		}, nil
	}

	var mdrBps, discountBps int64
	err = tx.QueryRow(ctx, `
		SELECT mdr_bps, negotiated_discount_bps FROM merchants WHERE id = $1 AND status = 'active' AND test_mode = false
	`, merchantID).Scan(&mdrBps, &discountBps)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return BatchResult{}, ErrMerchantNotEligible
		}
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: read merchant: %w", err)
	}

	schedules, err := LoadFeeSchedules(ctx, tx, merchantID)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: load fee schedules: %w", err)
	}

	platformProcessedFils, err := ReadAndLockPlatformProcessedFils(ctx, tx)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: read platform volume: %w", err)
	}
	tierBonusBps := VolumeTierMdrBonusBps(platformProcessedFils)

	rows, err := tx.Query(ctx, `
		SELECT te.id, te.transaction_id, te.amount_fils, te.occurred_at
		  FROM transaction_events te
		  JOIN transactions t ON t.id = te.transaction_id
		 WHERE t.merchant_id = $1
		   AND te.event_type IN ('captured', 'partially_captured')
		   AND te.settlement_batch_id IS NULL
		   AND te.occurred_at >= $2 AND te.occurred_at < $3
		 ORDER BY te.transaction_id, te.occurred_at
		 FOR UPDATE OF te
	`, merchantID, start, end)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: select eligible events: %w", err)
	}

	var events []eligibleEvent
	var orderedTxnIDs []uuid.UUID
	seenTxn := make(map[uuid.UUID]bool)
	for rows.Next() {
		var e eligibleEvent
		var amountFils int64
		if err := rows.Scan(&e.id, &e.transactionID, &amountFils, &e.occurredAt); err != nil {
			rows.Close()
			return BatchResult{}, fmt.Errorf("settlement: CloseBatch: scan eligible event: %w", err)
		}
		e.amountFils = money.Fils(amountFils)
		events = append(events, e)
		if !seenTxn[e.transactionID] {
			seenTxn[e.transactionID] = true
			orderedTxnIDs = append(orderedTxnIDs, e.transactionID)
		}
	}
	if err := rows.Err(); err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: iterate eligible events: %w", err)
	}
	rows.Close()

	grouped := make(map[uuid.UUID][]eligibleEvent, len(orderedTxnIDs))
	for _, e := range events {
		grouped[e.transactionID] = append(grouped[e.transactionID], e)
	}

	type txnLine struct {
		transactionID uuid.UUID
		grossFils     money.Fils
		feeFils       money.Fils
	}
	var lines []txnLine
	var batchGross, batchFee money.Fils
	var eventIDs []int64

	for _, txnID := range orderedTxnIDs {
		var grossForTxn, feeForTxn money.Fils
		for _, e := range grouped[txnID] {
			grossForTxn += e.amountFils
			effectiveMdrBps := EffectiveMdrBpsAt(schedules, e.occurredAt, mdrBps)
			if effectiveMdrBps -= tierBonusBps; effectiveMdrBps < 0 {
				effectiveMdrBps = 0
			}
			feeForTxn += ComputeSettlementFee(e.amountFils, effectiveMdrBps, discountBps)
			eventIDs = append(eventIDs, e.id)
		}
		lines = append(lines, txnLine{txnID, grossForTxn, feeForTxn})
		batchGross += grossForTxn
		batchFee += feeForTxn
	}
	netPayout := NetPayableFils(batchGross, batchFee)

	if err := RecordPlatformProcessedVolume(ctx, tx, platformProcessedFils, int64(batchGross)); err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: record platform volume: %w", err)
	}

	_, err = tx.Exec(ctx, `
		UPDATE settlement_batches
		   SET status = 'closed', gross_fils = $2, fee_fils = $3, net_payout_fils = $4, closed_at = now()
		 WHERE id = $1
	`, batchID, int64(batchGross), int64(batchFee), int64(netPayout))
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: freeze batch totals: %w", err)
	}

	if len(eventIDs) > 0 {
		_, err = tx.Exec(ctx, `
			UPDATE transaction_events SET settlement_batch_id = $2 WHERE id = ANY($1)
		`, eventIDs, batchID)
		if err != nil {
			return BatchResult{}, fmt.Errorf("settlement: CloseBatch: mark events batched: %w", err)
		}
	}

	for i, line := range lines {
		truncated := TruncateToSchemeAmount(line.grossFils)
		_, err = tx.Exec(ctx, `
			INSERT INTO scheme_export_lines (settlement_batch_id, transaction_id, amount_fils, amount, line_sequence)
			VALUES ($1, $2, $3, $4, $5)
		`, batchID, line.transactionID, int64(truncated), SchemeAmountBD(line.grossFils), i+1)
		if err != nil {
			return BatchResult{}, fmt.Errorf("settlement: CloseBatch: insert scheme export line: %w", err)
		}

		// BUG FIXED (ADR-0002): Journal scheme rounding residue at export.
		// The scheme settles in 2 decimals (multiple of 10 fils). The missing fils must be journaled to the residue account.
		residue := line.grossFils - truncated
		if residue > 0 {
			residueGroupID := uuid.New()
			_, err = tx.Exec(ctx, `
				INSERT INTO ledger_entries
				  (entry_group_id, merchant_id, settlement_batch_id, account_id, direction, amount_fils, occurred_at, description)
				VALUES
				  ($1, $2, $3, 'card_scheme_clearing', 'credit', $4, now(), 'scheme residue: truncation'),
				  ($1, $2, $3, 'scheme_rounding_residue', 'debit', $4, now(), 'scheme residue: truncation')
			`, residueGroupID, merchantID, batchID, int64(residue))
			if err != nil {
				return BatchResult{}, fmt.Errorf("settlement: CloseBatch: journal residue: %w", err)
			}
		}
	}

	payload, err := buildBatchClosedPayload(merchantID, batchID, batchDateOnly, batchGross, batchFee, netPayout)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: build outbox payload: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
		VALUES ('settlement.batch_closed', 'settlement_batch', $1, $2)
	`, batchID, payload)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: enqueue outbox event: %w", err)
	}

	if err := balances.ApplyBatchClose(ctx, tx, merchantID, batchID, netPayout); err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: apply balance cache delta: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: commit: %w", err)
	}

	return BatchResult{
		BatchID:       batchID,
		MerchantID:    merchantID,
		BatchDate:     batchDateOnly,
		AlreadyClosed: false,
		GrossFils:     batchGross,
		FeeFils:       batchFee,
		NetPayoutFils: netPayout,
		EventCount:    len(eventIDs),
		LineCount:     len(lines),
	}, nil
}

func PayoutBatch(ctx context.Context, db *pgxpool.Pool, batchID uuid.UUID) (PayoutResult, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var merchantID uuid.UUID
	var status string
	var netPayout int64
	err = tx.QueryRow(ctx, `
		SELECT merchant_id, status, net_payout_fils FROM settlement_batches WHERE id = $1 FOR UPDATE
	`, batchID).Scan(&merchantID, &status, &netPayout)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: batch %s not found", batchID)
		}
		return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: lock batch: %w", err)
	}

	if status == "paid" {
		tx.Rollback(ctx) //nolint:errcheck
		return PayoutResult{BatchID: batchID, MerchantID: merchantID, AlreadyPaid: true, NetPayoutFils: money.Fils(netPayout)}, nil
	}
	if status != "closed" {
		tx.Rollback(ctx) //nolint:errcheck
		return PayoutResult{BatchID: batchID, MerchantID: merchantID, NotClosed: true, NetPayoutFils: money.Fils(netPayout)}, nil
	}

	if netPayout > 0 {
		groupID := uuid.New()
		_, err = tx.Exec(ctx, `
			INSERT INTO ledger_entries
			  (entry_group_id, merchant_id, settlement_batch_id, account_id, direction, amount_fils, occurred_at, description)
			VALUES
			  ($1, $2, $3, 'merchant_payable', 'debit',  $4, now(), 'settlement payout: batch paid'),
			  ($1, $2, $3, 'platform_cash',    'credit', $4, now(), 'settlement payout: batch paid')
		`, groupID, merchantID, batchID, netPayout)
		if err != nil {
			return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: post payout legs: %w", err)
		}
	}

	if err := UpdateLifetimePayoutMonitoringEstimate(ctx, tx, merchantID, money.Fils(netPayout)); err != nil {
		return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: update lifetime payout monitoring estimate: %w", err)
	}

	_, err = tx.Exec(ctx, `
		UPDATE settlement_batches SET status = 'paid', paid_at = now() WHERE id = $1
	`, batchID)
	if err != nil {
		return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: update batch status: %w", err)
	}

	if err := balances.ApplyPayout(ctx, tx, merchantID, batchID, money.Fils(netPayout)); err != nil {
		return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: apply balance cache delta: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: commit: %w", err)
	}

	return PayoutResult{BatchID: batchID, MerchantID: merchantID, NetPayoutFils: money.Fils(netPayout)}, nil
}

type DailyBatchReport struct {
	BusinessDate    time.Time
	MerchantResults []MerchantBatchOutcome
}

type MerchantBatchOutcome struct {
	MerchantID    uuid.UUID
	BatchID       uuid.UUID
	AlreadyClosed bool
	AlreadyPaid   bool
	GrossFils     money.Fils
	FeeFils       money.Fils
	NetPayoutFils money.Fils
}

func RunDailyBatch(ctx context.Context, db *pgxpool.Pool, businessDate time.Time, onlyMerchant *uuid.UUID) (DailyBatchReport, error) {
	var merchantIDs []uuid.UUID
	if onlyMerchant != nil {
		merchantIDs = []uuid.UUID{*onlyMerchant}
	} else {
		rows, err := db.Query(ctx, `
			SELECT id FROM merchants WHERE status = 'active' AND test_mode = false ORDER BY id
		`)
		if err != nil {
			return DailyBatchReport{}, fmt.Errorf("settlement: RunDailyBatch: select merchants: %w", err)
		}
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return DailyBatchReport{}, fmt.Errorf("settlement: RunDailyBatch: scan merchant id: %w", err)
			}
			merchantIDs = append(merchantIDs, id)
		}
		if err := rows.Err(); err != nil {
			return DailyBatchReport{}, fmt.Errorf("settlement: RunDailyBatch: iterate merchants: %w", err)
		}
		rows.Close()
	}

	sort.Slice(merchantIDs, func(i, j int) bool { return merchantIDs[i].String() < merchantIDs[j].String() })

	report := DailyBatchReport{BusinessDate: businessDate}
	for _, merchantID := range merchantIDs {
		closeResult, err := CloseBatch(ctx, db, merchantID, businessDate)
		if err != nil {
			if errors.Is(err, ErrMerchantNotEligible) {
				continue
			}
			return report, fmt.Errorf("settlement: RunDailyBatch: CloseBatch(%s): %w", merchantID, err)
		}

		isSplitParent, err := splits.IsSplitParent(ctx, db, merchantID)
		if err != nil {
			return report, fmt.Errorf("settlement: RunDailyBatch: IsSplitParent(%s): %w", merchantID, err)
		}

		var alreadyPaid bool
		if isSplitParent {
			splitResult, err := splits.PayoutSplitBatch(ctx, db, closeResult.BatchID)
			if err != nil {
				return report, fmt.Errorf("settlement: RunDailyBatch: PayoutSplitBatch(%s): %w", closeResult.BatchID, err)
			}
			alreadyPaid = splitResult.AlreadyPaid
		} else {
			payoutResult, err := PayoutBatch(ctx, db, closeResult.BatchID)
			if err != nil {
				return report, fmt.Errorf("settlement: RunDailyBatch: PayoutBatch(%s): %w", closeResult.BatchID, err)
			}
			alreadyPaid = payoutResult.AlreadyPaid
		}

		report.MerchantResults = append(report.MerchantResults, MerchantBatchOutcome{
			MerchantID:    merchantID,
			BatchID:       closeResult.BatchID,
			AlreadyClosed: closeResult.AlreadyClosed,
			AlreadyPaid:   alreadyPaid,
			GrossFils:     closeResult.GrossFils,
			FeeFils:       closeResult.FeeFils,
			NetPayoutFils: closeResult.NetPayoutFils,
		})
	}

	return report, nil
}