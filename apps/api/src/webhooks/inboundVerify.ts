import { createHmac } from "node:crypto";
import { canonicalJson } from "../payments/idempotency.js";

interface ParsedAcquirerSignatureHeader {
  timestamp: number;
  signature: string;
}

function parseAcquirerSignatureHeader(header: string): ParsedAcquirerSignatureHeader | null {
  let timestampStr: string | null = null;
  let signature: string | null = null;

  for (const part of header.split(",")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) continue;
    const key = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();
    if (key === "t") timestampStr = value;
    else if (key === "v1") signature = value;
  }

  if (!timestampStr || !signature) return null;
  if (!/^\d+$/.test(timestampStr)) return null;

  const timestamp = Number.parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp)) return null;

  return { timestamp, signature };
}

export type VerifyAcquirerCallbackFailureReason = "malformed_header" | "signature_mismatch";

export interface VerifyAcquirerCallbackResult {
  valid: boolean;
  reason?: VerifyAcquirerCallbackFailureReason;
}

function constantTimeEquals(a: string, b: string): boolean {
  return (
    Buffer.from(a).length === Buffer.from(b).length &&
    Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0
  );
}

/**
 * BUG (FP-240 class): signer and verifier disagreed on the serialization.
 * The acquirer signs `${t}.${JSON.stringify(body)}`; our verifier only tried
 * `canonicalJson(body)`, so a correctly-signed callback got 401. There is no
 * single canonical wire form yet, so accept either — both are HMACs over the
 * same logical body, and constant-time compared.
 */
export function verifyAcquirerCallbackSignature(
  payload: unknown,
  header: string | undefined,
  secret: string,
  requireSignature = false,
): VerifyAcquirerCallbackResult {
  if (!header) {
    return requireSignature ? { valid: false, reason: "malformed_header" } : { valid: true };
  }

  const parsed = parseAcquirerSignatureHeader(header);
  if (!parsed) return { valid: false, reason: "malformed_header" };

  const bodies = [canonicalJson(payload), JSON.stringify(payload)];
  for (const body of bodies) {
    const expected = createHmac("sha256", secret)
      .update(`${parsed.timestamp}.${body}`)
      .digest("hex");
    if (constantTimeEquals(expected, parsed.signature)) return { valid: true };
  }
  return { valid: false, reason: "signature_mismatch" };
}