import { ZERO_FILS, compareFils, subtractFils, type Fils } from "@filspay/money";

export interface RefundableTransaction {
  id: string;
  merchantId: string;
  status: string;
  capturedFils: Fils;
  refundedFils: Fils; // BUG FIXED: pass refundedFils directly
}

export type RefundValidation =
  | { ok: true; amountFils: Fils }
  | { ok: false; code: "transaction_not_refundable"; status: string }
  | { ok: false; code: "refund_amount_invalid" }
  | { ok: false; code: "refund_exceeds_refundable"; refundableFils: Fils };

const REFUNDABLE_STATUSES = new Set(["captured", "partially_captured", "partially_refunded"]);

/** How much this transaction may still return. Max = what we actually captured, minus what we already refunded. */
export function refundableAmount(txn: RefundableTransaction): Fils {
  return subtractFils(txn.capturedFils, txn.refundedFils);
}

export function validateRefundRequest(
  txn: RefundableTransaction,
  requestedAmountFils?: Fils,
): RefundValidation {
  if (!REFUNDABLE_STATUSES.has(txn.status)) {
    return { ok: false, code: "transaction_not_refundable", status: txn.status };
  }

  if (compareFils(txn.capturedFils, ZERO_FILS) === 0) {
    return { ok: false, code: "transaction_not_refundable", status: txn.status };
  }

  const refundable = refundableAmount(txn);
  const requested = requestedAmountFils ?? refundable;

  if (compareFils(requested, ZERO_FILS) <= 0) {
    return { ok: false, code: "refund_amount_invalid" };
  }
  if (compareFils(requested, refundable) > 0) {
    return { ok: false, code: "refund_exceeds_refundable", refundableFils: refundable };
  }

  return { ok: true, amountFils: requested };
}