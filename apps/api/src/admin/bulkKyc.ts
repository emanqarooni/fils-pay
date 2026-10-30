import type { Pool } from "pg";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";

export interface BulkApproveMerchantsKycInput {
  merchantIds: string[];
  adminUserId: string;
  notes?: string;
}

export interface BulkApproveMerchantsKycResult {
  approvedCount: number;
  approvedMerchantIds: string[];
}

export async function bulkApproveMerchantsKyc(
  pool: Pool,
  input: BulkApproveMerchantsKycInput,
): Promise<BulkApproveMerchantsKycResult> {
  return withTransaction(pool, async (client) => {
    // BUG FIXED: ADMIN.md says "Only merchants currently under_review are affected".
    // Added AND onboarding_status = 'under_review' so it doesn't overwrite approved/rejected ones.
    const result = await client.query<{ id: string }>(
      `UPDATE merchants
          SET onboarding_status = 'approved', kyc_passed = true
        WHERE id = ANY($1::uuid[])
          AND onboarding_status = 'under_review'
      RETURNING id`,
      [input.merchantIds],
    );
    const approvedMerchantIds = result.rows.map((row) => row.id);

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "kyc_bulk_approve",
      targetType: "platform",
      targetId: null,
      metadata: {
        requestedMerchantIds: input.merchantIds,
        approvedMerchantIds,
        notes: input.notes ?? null,
      },
    });

    return { approvedCount: approvedMerchantIds.length, approvedMerchantIds };
  });
}