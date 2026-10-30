package settlement

// ... imports ...

func RecalculateMDR(ctx context.Context, db *pgxpool.Pool, merchantID uuid.UUID, from, to time.Time) (RecalcResult, error) {
	// ... setup ...

	rows, err := tx.Query(ctx, `
		SELECT id, batch_date, status, gross_fils, fee_fils, net_payout_fils
		  FROM settlement_batches
		 WHERE merchant_id = $1 AND batch_date >= $2 AND batch_date < $3
		   AND status = 'closed'
		 ORDER BY batch_date
		 FOR UPDATE
	`, merchantID, from, to)
    // ... rest of code ...