import { ZERO_FILS, compareFils, type Fils } from "@filspay/money";

export type PostRefundStatus = "captured" | "partially_captured" | "partially_refunded" | "refunded";

export interface PostRefundStatusInput {
  amountFils: Fils;
  capturedFils: Fils;
  refundedTotalFils: Fils;
}

export function nextStatusAfterRefund(input: PostRefundStatusInput): PostRefundStatus {
  // BUG FIXED: If everything we captured is refunded, it is "refunded", even if it was a partial capture.
  if (compareFils(input.refundedTotalFils, input.capturedFils) >= 0) {
    return "refunded";
  }
  
  if (compareFils(input.refundedTotalFils, ZERO_FILS) > 0) {
    return "partially_refunded";
  }

  // No refunds yet. Keep the capture status.
  if (compareFils(input.capturedFils, input.amountFils) < 0) {
    return "partially_captured";
  }
  return "captured";
}