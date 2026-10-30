import type { Pool } from "pg";
import type { Fils } from "@filspay/money";
import type { AcquirerSimulator } from "../acquirer/types.js";
import type { MerchantAuthContext, MerchantWriterActor } from "../auth/requireMerchantAuth.js";
import { processRefund, type ProcessRefundResult } from "../payments/processRefund.js";
import { ForbiddenError, NotFoundError } from "../lib/errors.js";

export function assertRefundRequestScope(auth: MerchantAuthContext, merchantIdParam: string): void {
  if (auth.merchantId !== merchantIdParam) {
    throw new ForbiddenError("forbidden");
  }
}

export interface InitiateMerchantRefundInput {
  merchantId: string;
  transactionId: string;
  amountFils?: Fils;
  idempotencyKey: string;
  actor: MerchantWriterActor;
  reason?: string;
}

async function assertRefundsNotOnHold(pool: Pool, merchantId: string): Promise<void> {
  const result = await pool.query<{ refunds_enabled: boolean | null }>(
    `SELECT refunds_enabled FROM merchants WHERE id = $1`,
    [merchantId],
  );
  const merchant = result.rows[0];
  if (merchant && merchant.refunds_enabled === false) {
    throw new ForbiddenError("refunds_on_hold");
  }
}

export async function initiateMerchantRefund(
  pool: Pool,
  acquirer: AcquirerSimulator,
  input: InitiateMerchantRefundInput,
): Promise<ProcessRefundResult> {
  await assertRefundsNotOnHold(pool, input.merchantId);

  const result = await pool.query<{ id: string; merchant_id: string }>(
    `SELECT id, merchant_id FROM transactions WHERE id = $1`,
    [input.transactionId],
  );
  const txn = result.rows[0];
  
  // BUG FIXED: Must check if transaction belongs to this merchant
  if (!txn || txn.merchant_id !== input.merchantId) {
    throw new NotFoundError("transaction_not_found");
  }

  return processRefund(pool, acquirer, {
    transactionId: txn.id,
    merchantId: txn.merchant_id,
    amountFils: input.amountFils,
    idempotencyKey: input.idempotencyKey,
    actor: input.actor,
    reason: input.reason,
  });
}