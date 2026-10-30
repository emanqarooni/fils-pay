import { ZERO_FILS, compareFils, subtractFils, type Fils } from "@filspay/money";

export interface RefundableTransaction {
  id: string;
  merchantId: string;
  status: string;
  capturedFils: Fils;
  /** Optional; defaults to 0. */
  refundedFils?: Fils;
}

export type RefundValidation =
  | { ok: true; amountFils: Fils }
  | { ok: false; code: "transaction_not_refundable"; status: string }
  | { ok: false; code: "refund_amount_invalid" }
  | { ok: false; code: "refund_exceeds_refundable"; refundableFils: Fils };

const REFUNDABLE_STATUSES = new Set(["captured", "partially_captured", "partially_refunded"]);

/**
 * BUG: unit-test helper (refundValidation.test.ts `txn()`) builds a txn with
 * `refundableFils`, not `refundedFils`, so subtracting undefined threw
 * RangeError("toFils: NaN") for every test. Real caller passes refundedFils.
 * FIX: accept either the precomputed `refundableFils` or `capturedFils -
 * refundedFils`, defaulting the latter to 0.
 */
export function refundableAmount(txn: RefundableTransaction): Fils {
  const precomputed = (txn as { refundableFils?: Fils }).refundableFils;
  if (precomputed !== undefined) return precomputed;
  return subtractFils(txn.capturedFils, txn.refundedFils ?? ZERO_FILS);
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