import type { Pool } from "pg";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { insertReplayDeliveryRow } from "./replay.js";

const MAX_BATCH_SIZE = 500;

export const DEFAULT_REPLAY_STATUSES = ["exhausted"] as const;

export interface BatchReplayResult {
  matchedCount: number;
  replayedDeliveryIds: string[];
}

export async function replayWebhookDeliveriesBatch(
  pool: Pool,
  input: {
    merchantId: string;
    endpointId: string;
    adminUserId: string;
    from: Date;
    to: Date;
    statuses: string[];
  },
): Promise<BatchReplayResult> {
  return withTransaction(pool, async (client) => {
    const endpoint = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM webhook_endpoints WHERE id = $1 AND merchant_id = $2`,
      [input.endpointId, input.merchantId],
    );
    const endpointRow = endpoint.rows[0];
    if (!endpointRow) {
      throw new NotFoundError("webhook_endpoint_not_found");
    }
    if (endpointRow.status !== "active") {
      throw new ConflictError("endpoint_disabled");
    }

    const candidates = await client.query<{
      id: string;
      delivery_event_id: string;
      endpoint_id: string;
      outbox_event_id: string;
      event_type: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT id, delivery_event_id, endpoint_id, outbox_event_id, event_type, payload
         FROM webhook_deliveries
        WHERE endpoint_id = $1 AND status = ANY($2)
          AND created_at >= $3 AND created_at < $4
        ORDER BY created_at ASC
        LIMIT $5`,
      [input.endpointId, input.statuses, input.from, input.to, MAX_BATCH_SIZE],
    );

    const replayedDeliveryIds: string[] = [];
    for (const row of candidates.rows) {
      const inserted = await insertReplayDeliveryRow(client, {
        id: row.id,
        deliveryEventId: row.delivery_event_id,
        endpointId: row.endpoint_id,
        outboxEventId: row.outbox_event_id,
        eventType: row.event_type,
        payload: row.payload,
      });
      replayedDeliveryIds.push(inserted.deliveryId);
    }

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "webhook_batch_replay",
      targetType: "webhook_endpoint",
      targetId: input.endpointId,
      metadata: {
        merchantId: input.merchantId,
        from: input.from.toISOString(),
        to: input.to.toISOString(),
        statuses: input.statuses,
        replayedDeliveryIds,
      },
    });

    return { matchedCount: candidates.rows.length, replayedDeliveryIds };
  });
}