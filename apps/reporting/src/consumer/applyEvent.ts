import type { PoolClient } from "pg";
import { toBahrainDateString } from "../bahrainDate.js";

export interface OutboxEventRow {
  id: string | number | bigint;
  event_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

/**
 * BUG: producers/fixtures disagree on payload casing and nesting — flat
 * camelCase { merchantId }, nested { data: { merchantId } }, and snake_case
 * { merchant_id } all reach the outbox. applyTransactionCaptured only read
 * payload.merchantId, so nested/snake rows inserted merchant_id = NULL
 * (Postgres not-null rejection). FIX: one reader that accepts both casings
 * at the top level and under `data`, and throws loudly rather than writing NULL.
 */
function readString(row: OutboxEventRow, camel: string, snake: string): string | undefined {
  const p = row.payload as Record<string, unknown>;
  const data = (p.data ?? {}) as Record<string, unknown>;
  const v = p[camel] ?? data[camel] ?? p[snake] ?? data[snake];
  return typeof v === "string" && v !== "" ? v : undefined;
}

function readMerchantId(row: OutboxEventRow): string {
  const id = readString(row, "merchantId", "merchant_id");
  if (!id) throw new Error(`applyEvent: payload has no merchantId (event ${String(row.id)}, type ${row.event_type})`);
  return id;
}

function readNumber(row: OutboxEventRow, camel: string, snake: string): number {
  const p = row.payload as Record<string, unknown>;
  const data = (p.data ?? {}) as Record<string, unknown>;
  const raw = p[camel] ?? data[camel] ?? p[snake] ?? data[snake];
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`applyEvent: payload.${camel} is not a finite number (event ${String(row.id)})`);
  return n;
}

async function applyTransactionCaptured(client: PoolClient, row: OutboxEventRow): Promise<void> {
  const merchantId = readMerchantId(row);
  const amountCapturedFils = readNumber(row, "amountCapturedFils", "amount_captured_fils");
  const volumeDate = toBahrainDateString(row.created_at);
  await client.query(
    `INSERT INTO merchant_daily_volume (merchant_id, volume_date, captured_count, captured_gross_fils, last_updated_at)
     VALUES ($1, $2, 1, $3, now())
     ON CONFLICT (merchant_id, volume_date) DO UPDATE
       SET captured_count = merchant_daily_volume.captured_count + 1,
           captured_gross_fils = merchant_daily_volume.captured_gross_fils + EXCLUDED.captured_gross_fils,
           last_updated_at = now()`,
    [merchantId, volumeDate, amountCapturedFils],
  );
}

async function applyTransactionVoided(client: PoolClient, row: OutboxEventRow): Promise<void> {
  const merchantId = readMerchantId(row);
  const volumeDate = toBahrainDateString(row.created_at);
  await client.query(
    `INSERT INTO merchant_daily_volume (merchant_id, volume_date, voided_count, last_updated_at)
     VALUES ($1, $2, 1, now())
     ON CONFLICT (merchant_id, volume_date) DO UPDATE
       SET voided_count = merchant_daily_volume.voided_count + 1,
           last_updated_at = now()`,
    [merchantId, volumeDate],
  );
}

function bahrainLocalMidnightUtc(dateStr: string): Date {
  const parsed = new Date(`${dateStr}T00:00:00+03:00`);
  if (Number.isNaN(parsed.getTime())) throw new RangeError(`bahrainLocalMidnightUtc: invalid date "${dateStr}"`);
  return parsed;
}

async function applyBatchClosed(client: PoolClient, row: OutboxEventRow): Promise<void> {
  const merchantId = readMerchantId(row);
  const batchId = readString(row, "batchId", "batch_id");
  const batchDate = readString(row, "batchDate", "batch_date");
  if (!batchId || !batchDate) throw new Error(`applyBatchClosed: payload missing batchId/batchDate (event ${String(row.id)})`);
  const grossFils = readNumber(row, "grossFils", "gross_fils");
  const feeFils = readNumber(row, "feeFils", "fee_fils");
  const netPayoutFils = readNumber(row, "netPayoutFils", "net_payout_fils");

  const batchResult = await client.query<{ status: string; paid_at: Date | null }>(
    `SELECT status, paid_at FROM settlement_batches WHERE id = $1`,
    [batchId],
  );
  const batch = batchResult.rows[0];
  if (!batch) return;

  await client.query(
    `INSERT INTO merchant_payout_trends
        (merchant_id, settlement_batch_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, paid_at, last_updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (merchant_id, settlement_batch_id) DO UPDATE
       SET status = EXCLUDED.status, gross_fils = EXCLUDED.gross_fils,
           fee_fils = EXCLUDED.fee_fils, net_payout_fils = EXCLUDED.net_payout_fils,
           paid_at = EXCLUDED.paid_at, last_updated_at = now()`,
    [merchantId, batchId, batchDate, batch.status, grossFils, feeFils, netPayoutFils, batch.paid_at],
  );

  const windowStart = bahrainLocalMidnightUtc(batchDate);
  const windowEnd = new Date(windowStart.getTime() + 24 * 60 * 60 * 1000);
  const groundTruth = await client.query<{ event_count: string }>(
    `SELECT COUNT(*)::text AS event_count
       FROM transaction_events te
       JOIN transactions t ON t.id = te.transaction_id
      WHERE t.merchant_id = $1
        AND te.event_type IN ('captured', 'partially_captured')
        AND te.occurred_at >= $2 AND te.occurred_at < $3`,
    [merchantId, windowStart, windowEnd],
  );
  const groundTruthCount = Number(groundTruth.rows[0]?.event_count ?? "0");
  if (groundTruthCount > 0) {
    const rollupResult = await client.query(
      `SELECT captured_count FROM merchant_daily_volume WHERE merchant_id = $1 AND volume_date = $2`,
      [merchantId, batchDate],
    );
    const rollup = rollupResult.rows[0] as { captured_count: number };
    if (rollup.captured_count < groundTruthCount) {
      console.warn(
        `reporting rollup lags ground truth for merchant ${merchantId} on ${batchDate}: ` +
          `rollup=${rollup.captured_count} ground_truth=${groundTruthCount}`,
      );
    }
  }
}

export async function applyDailySummaryRollup(
  client: PoolClient,
  merchantId: string,
  occurredAt: Date,
  amountFils: number,
): Promise<void> {
  const summaryDate = occurredAt.toISOString().slice(0, 10);
  await client.query(
    `INSERT INTO merchant_daily_volume (merchant_id, volume_date, refund_count, refund_gross_fils, last_updated_at)
     VALUES ($1, $2, 1, $3, now())
     ON CONFLICT (merchant_id, volume_date) DO UPDATE
       SET refund_count = merchant_daily_volume.refund_count + 1,
           refund_gross_fils = merchant_daily_volume.refund_gross_fils + EXCLUDED.refund_gross_fils,
           last_updated_at = now()`,
    [merchantId, summaryDate, amountFils],
  );
}

export async function applyEvent(client: PoolClient, row: OutboxEventRow): Promise<void> {
  switch (row.event_type) {
    case "transaction.captured":
      return applyTransactionCaptured(client, row);
    case "transaction.voided":
      return applyTransactionVoided(client, row);
    case "settlement.batch_closed":
      return applyBatchClosed(client, row);
    default:
      throw new Error(`applyEvent: unhandled event_type ${row.event_type}`);
  }
}