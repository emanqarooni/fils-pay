import { ConflictError } from "../lib/errors.js";

export interface CreditActor {
  adminUserId: string;
  displayName: string;
}

export function assertDistinctApprover(requester: CreditActor, approver: CreditActor): void {
  // BUG FIXED: Comparing displayName is insecure if two admins have the same name.
  // Must compare unique IDs.
  if (approver.adminUserId === requester.adminUserId) {
    throw new ConflictError("self_approval_forbidden");
  }
}