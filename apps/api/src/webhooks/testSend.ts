import type { Pool } from "pg";
import type { Config } from "../config.js";
import { decodeEncryptionKey, decryptSecret } from "./secretCrypto.js";
import { signPayload } from "./sign.js";
import { canonicalJson } from "../payments/idempotency.js";
import { WEBHOOK_SIGNATURE_HEADER } from "./headers.js";
import type { WebhookTransport } from "./transport.js";
import { NotFoundError } from "../lib/errors.js";

export interface TestSendResult {
  statusCode: number | null;
  responseBodyExcerpt: string | null;
  timedOutOrUnreachable: boolean;
}

interface EndpointSecretRow {
  url: string;
  secret_ciphertext: string;
  status: string;
}

export async function sendTestWebhookEvent(
  pool: Pool,
  config: Pick<Config, "webhookSecretEncryptionKey" | "webhookRequestTimeoutMs">,
  transport: WebhookTransport,
  input: { merchantId: string; endpointId: string },
): Promise<TestSendResult> {
  const result = await pool.query<EndpointSecretRow>(
    `SELECT url, secret_ciphertext, status FROM webhook_endpoints WHERE id = $1 AND merchant_id = $2`,
    [input.endpointId, input.merchantId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("webhook_endpoint_not_found");
  }

  const testPayload = {
    id: `test_${input.endpointId}`,
    type: "test.ping",
    createdAt: new Date().toISOString(),
    data: { message: "This is a test event from FilsPay." },
  };

  const key = decodeEncryptionKey(config.webhookSecretEncryptionKey);
  const secret = decryptSecret(row.secret_ciphertext, key);
  
  const rawBody = canonicalJson(testPayload);
  const { signature } = signPayload(rawBody, secret);

  const response = await transport({
    url: row.url,
    headers: { [WEBHOOK_SIGNATURE_HEADER]: signature, "Content-Type": "application/json" },
    body: rawBody,
    timeoutMs: config.webhookRequestTimeoutMs,
  });

  return {
    statusCode: response.statusCode,
    responseBodyExcerpt: response.statusCode === null ? null : response.body.slice(0, 2000),
    timedOutOrUnreachable: response.statusCode === null,
  };
}