import { randomUUID } from "node:crypto";
import { Client, type Pool } from "pg";
import type { Config } from "../config.js";
import { withTransaction } from "../db/withTransaction.js";
import { decodeEncryptionKey, decryptSecret } from "./secretCrypto.js";
import { signPayload } from "./sign.js";
import { canonicalJson } from "../payments/idempotency.js";
import { buildEnvelope } from "./envelope.js";
import { recordPayoutDisbursementEffect } from "./payoutDisbursement.js";
import { WEBHOOK_DELIVERY_ID_HEADER, WEBHOOK_SIGNATURE_HEADER } from "./headers.js";
import type { WebhookTransport } from "./transport.js";

const STEP_A_BATCH_LIMIT = 500;
const STEP_B_BATCH_LIMIT = 100;
const WEBHOOK_ELIGIBLE_EVENT_TYPES: readonly string[] = [
  "transaction.captured",
  "transaction.voided",
  "settlement.paid",
];
const NOTIFY_CHANNEL = "outbox_events_channel";

type PreDeliveryEffect = (pool: Pool, payload: Record<string, unknown>) => Promise<void>;

const PRE_DELIVERY_EFFECTS: Record<string, PreDeliveryEffect> = {
  "settlement.paid": async (pool, payload) => {
    const data = payload.data as { settlementBatchId: string; netPayoutFils: number };
    await recordPayoutDisbursementEffect(pool, data.settlementBatchId, Number(data.netPayoutFils));
  },
};

export type DispatcherConfig = Pick<
  Config,
  | "webhookMaxAttempts"
  | "webhookBackoffBaseMs"
  | "webhookBackoffCapMs"
  | "webhookRequestTimeoutMs"
  | "webhookSecretEncryptionKey"
>;

export function backoffDelayMs(
  attemptNumber: number,
  config: Pick<Config, "webhookBackoffBaseMs" | "webhookBackoffCapMs">,
  jitter: () => number = Math.random,
): number {
  const raw = config.webhookBackoffBaseMs * 2 ** (attemptNumber - 1);
  const capped = Math.min(raw, config.webhookBackoffCapMs);
  return Math.round(capped * (0.9 + jitter() * 0.2));
}

interface DueEventRow {
  outbox_event_id: string;
  event_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  created_at: Date;
  endpoint_id: string;
}

async function createMissingDeliveries(pool: Pool): Promise<number> {
  return withTransaction(pool, async (client) => {
    const dueResult = await client.query<DueEventRow>(
      `SELECT oe.id AS outbox_event_id, oe.event_type, oe.aggregate_id, oe.payload, oe.created_at,
              we.id AS endpoint_id
         FROM outbox_events oe
         JOIN webhook_endpoints we
           ON we.merchant_id = (oe.payload->>'merchantId')::uuid
          AND we.status = 'active'
          AND oe.created_at >= we.created_at
        WHERE oe.event_type = ANY($1::text[])
          AND NOT EXISTS (
            SELECT 1 FROM webhook_deliveries wd
             WHERE wd.outbox_event_id = oe.id AND wd.endpoint_id = we.id
          )
        ORDER BY oe.id ASC
        LIMIT $2`,
      [WEBHOOK_ELIGIBLE_EVENT_TYPES, STEP_A_BATCH_LIMIT],
    );

    let createdCount = 0;
    for (const row of dueResult.rows) {
      const deliveryEventId = randomUUID();
      const envelope = buildEnvelope(deliveryEventId, {
        eventType: row.event_type,
        aggregateId: row.aggregate_id,
        payload: row.payload,
        createdAt: row.created_at,
      });

      const insertResult = await client.query(
        `INSERT INTO webhook_deliveries
            (endpoint_id, outbox_event_id, event_type, delivery_event_id, payload, status, next_attempt_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', now())
         ON CONFLICT (outbox_event_id, endpoint_id) WHERE replay_of_delivery_id IS NULL DO NOTHING`,
        [row.endpoint_id, row.outbox_event_id, row.event_type, deliveryEventId, JSON.stringify(envelope)],
      );
      createdCount += insertResult.rowCount ?? 0;
    }
    return createdCount;
  });
}

interface DueDeliveryRow {
  id: string;
  endpoint_id: string;
  event_type: string;
  delivery_event_id: string;
  payload: Record<string, unknown>;
  attempt_count: number;
  url: string;
  secret_ciphertext: string;
}

async function attemptOneDelivery(
  pool: Pool,
  transport: WebhookTransport,
  config: DispatcherConfig,
  row: DueDeliveryRow,
): Promise<void> {
  // BUG FIXED: Atomic claim to prevent duplicate processing (Incident 2026-08-21)
  const claimResult = await pool.query(
    `UPDATE webhook_deliveries
        SET next_attempt_at = now() + interval '5 minutes'
      WHERE id = $1 AND status = 'pending' AND next_attempt_at <= now()`,
    [row.id],
  );

  if (claimResult.rowCount === 0) {
    return; // Another worker grabbed it
  }

  const key = decodeEncryptionKey(config.webhookSecretEncryptionKey);
  const secret = decryptSecret(row.secret_ciphertext, key);
  
  // BUG FIXED: Sign exactly the string we send (FP-240)
  const rawBody = canonicalJson(row.payload);
  const { signature } = signPayload(rawBody, secret);

  if (row.attempt_count === 0) {
    const effect = PRE_DELIVERY_EFFECTS[row.event_type];
    if (effect) await effect(pool, row.payload);
  }

  const result = await transport({
    url: row.url,
    headers: {
      [WEBHOOK_SIGNATURE_HEADER]: signature,
      [WEBHOOK_DELIVERY_ID_HEADER]: row.delivery_event_id,
      "Content-Type": "application/json",
    },
    body: rawBody, // Send the exact signed string
    timeoutMs: config.webhookRequestTimeoutMs,
  });

  const isTransportFailure = result.statusCode === null;
  const responseStatusCode = isTransportFailure ? null : result.statusCode;
  const responseBodyParam = isTransportFailure ? null : result.body;

  if (!isTransportFailure && result.statusCode! >= 200 && result.statusCode! < 300) {
    await pool.query(
      `UPDATE webhook_deliveries
          SET status = 'succeeded', attempt_count = attempt_count + 1, signature = $2,
              response_status_code = $3, response_body_excerpt = left($4, 2000), last_attempted_at = now()
        WHERE id = $1`,
      [row.id, signature, responseStatusCode, responseBodyParam],
    );
    return;
  }

  const newAttemptCount = row.attempt_count + 1;
  if (newAttemptCount >= config.webhookMaxAttempts) {
    await pool.query(
      `UPDATE webhook_deliveries
          SET status = 'exhausted', attempt_count = attempt_count + 1, signature = $2,
              response_status_code = $3, response_body_excerpt = left($4, 2000), last_attempted_at = now()
        WHERE id = $1`,
      [row.id, signature, responseStatusCode, responseBodyParam],
    );
    return;
  }

  const delayMs = backoffDelayMs(newAttemptCount, config);
  await pool.query(
    `UPDATE webhook_deliveries
        SET attempt_count = attempt_count + 1, signature = $2,
            response_status_code = $3, response_body_excerpt = left($4, 2000),
            next_attempt_at = now() + ($5::text || ' milliseconds')::interval, last_attempted_at = now()
      WHERE id = $1`,
    [row.id, signature, responseStatusCode, responseBodyParam, delayMs],
  );
}

async function attemptDueDeliveries(pool: Pool, transport: WebhookTransport, config: DispatcherConfig): Promise<number> {
  const dueResult = await pool.query<DueDeliveryRow>(
    `SELECT wd.id, wd.endpoint_id, wd.event_type, wd.delivery_event_id, wd.payload, wd.attempt_count, we.url, we.secret_ciphertext
       FROM webhook_deliveries wd
       JOIN webhook_endpoints we ON we.id = wd.endpoint_id
      WHERE wd.status = 'pending' AND wd.next_attempt_at <= now()
      ORDER BY wd.next_attempt_at ASC
      LIMIT $1`,
    [STEP_B_BATCH_LIMIT],
  );

  for (const row of dueResult.rows) {
    try {
      await attemptOneDelivery(pool, transport, config, row);
    } catch (err: unknown) {
      console.error(
        "[webhooks/dispatcher] delivery attempt threw before/around transport call, skipping row for this pass",
        { deliveryId: row.id, endpointId: row.endpoint_id, err },
      );
    }
  }
  return dueResult.rows.length;
}

export async function runDispatchPass(
  pool: Pool,
  transport: WebhookTransport,
  config: DispatcherConfig,
): Promise<{ createdCount: number; attemptedCount: number }> {
  const createdCount = await createMissingDeliveries(pool);
  const attemptedCount = await attemptDueDeliveries(pool, transport, config);
  return { createdCount, attemptedCount };
}

export interface WebhookDispatcherHandle {
  stop(): Promise<void>;
}

export function startWebhookDispatcher(pool: Pool, transport: WebhookTransport, config: Config): WebhookDispatcherHandle {
  let running = false;
  let stopped = false;

  const triggerPass = (): void => {
    if (running || stopped) return;
    running = true;
    runDispatchPass(pool, transport, config)
      .catch((err: unknown) => {
        console.error("[webhooks/dispatcher] dispatch pass failed", err);
      })
      .finally(() => {
        running = false;
      });
  };

  const listenClient = new Client({ connectionString: config.databaseUrl });
  let listenClientConnected = false;

  listenClient.on("error", (err: Error) => {
    console.error("[webhooks/dispatcher] LISTEN client error", err);
  });
  listenClient.on("notification", () => {
    triggerPass();
  });

  const connectPromise = listenClient
    .connect()
    .then(async () => {
      listenClientConnected = true;
      await listenClient.query(`LISTEN ${NOTIFY_CHANNEL}`);
    })
    .catch((err: unknown) => {
      console.error("[webhooks/dispatcher] failed to establish LISTEN connection", err);
    });

  const interval = setInterval(triggerPass, config.webhookPollIntervalMs);

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(interval);
      await connectPromise;
      if (listenClientConnected) {
        await listenClient.end().catch(() => {});
      }
    },
  };
}