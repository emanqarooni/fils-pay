import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/withTransaction.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";

export interface ReplayResult {
  deliveryId: string;
  status: string;
}

export interface OriginalDelivery {
  id: string;
  deliveryEventId: string; // Added to keep the ID stable
  endpointId: string;
  outboxEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export async function insertReplayDeliveryRow(
  client: PoolClient,
  original: OriginalDelivery,
): Promise<ReplayResult> {
  // BUG FIXED: Reuse the original delivery_event_id instead of generating a new one
  const replayPayload = { ...original.payload, id: original.deliveryEventId };

  const insertResult = await client.query<{ id: string; status: string }>(
    `INSERT INTO webhook_deliveries
        (endpoint_id, outbox_event_id, event_type, delivery_event_id, payload, status, next_attempt_at, replay_of_delivery_id)
     VALUES ($1, $2, $3, $4, $5, 'pending', now(), $6)
     RETURNING id, status`,
    [
      original.endpointId,
      original.outboxEventId,
      original.eventType,
      original.deliveryEventId,
      JSON.stringify(replayPayload),
      original.id,
    ],
  );
  const row = insertResult.rows[0];
  if (!row) {
    throw new Error("insertReplayDeliveryRow: insert into webhook_deliveries returned no row");
  }
  return { deliveryId: row.id, status: row.status };
}

interface OriginalDeliveryRow {
  id: string;
  delivery_event_id: string;
  endpoint_id: string;
  outbox_event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  endpoint_status: string;
}

export async function replayWebhookDelivery(
  pool: Pool,
  input: { merchantId: string; endpointId: string; deliveryId: string },
): Promise<ReplayResult> {
  const lookupResult = await pool.query<OriginalDeliveryRow>(
    `SELECT wd.id, wd.delivery_event_id, wd.endpoint_id, wd.outbox_event_id, wd.event_type, wd.payload, we.status AS endpoint_status
       FROM webhook_deliveries wd
       JOIN webhook_endpoints we ON we.id = wd.endpoint_id
      WHERE wd.id = $1 AND wd.endpoint_id = $2 AND we.merchant_id = $3`,
    [input.deliveryId, input.endpointId, input.merchantId],
  );
  const original = lookupResult.rows[0];
  if (!original) {
    throw new NotFoundError("webhook_delivery_not_found");
  }
  if (original.endpoint_status !== "active") {
    throw new ConflictError("endpoint_disabled");
  }

  return withTransaction(pool, async (client) =>
    insertReplayDeliveryRow(client, {
      id: original.id,
      deliveryEventId: original.delivery_event_id,
      endpointId: original.endpoint_id,
      outboxEventId: original.outbox_event_id,
      eventType: original.event_type,
      payload: original.payload,
    }),
  );
}