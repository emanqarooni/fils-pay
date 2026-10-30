import { createHmac } from "node:crypto";
import { canonicalJson } from "../payments/idempotency.js";
import { timingSafeEqualHex } from "../lib/crypto.js";

/**
 * Webhook signing: canonical (key-order-independent) serialization, a
 * timestamped Stripe-`t=...,v1=...`-style signature scheme, and a
 * constant-time comparison in verifySignature.
 */

export interface SignedPayload {
  /** unix seconds, the value folded into the signature */
  timestamp: number;
  /** header value: "t=<timestamp>,v1=<hex-hmac-sha256>" */
  signature: string;
}

/**
 * Helper to ensure we sign exactly what we send. If the caller passes a
 * string (e.g., the exact body being sent over the wire), we use it as-is.
 * If they pass an object, we canonicalize it.
 */
function getPayloadString(payload: unknown | string): string {
  return typeof payload === "string" ? payload : canonicalJson(payload);
}

/**
 * Computes the header value a delivery carries. `secret` is the raw
 * (decrypted) webhook secret.
 *
 * Signs `${timestamp}.${getPayloadString(payload)}`, not the payload alone,
 * so a receiver can enforce its own freshness window.
 */
export function signPayload(
  payload: unknown | string,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): SignedPayload {
  const signedString = `${timestamp}.${getPayloadString(payload)}`;
  const signature = createHmac("sha256", secret).update(signedString).digest("hex");
  return { timestamp, signature: `t=${timestamp},v1=${signature}` };
}

interface ParsedSignatureHeader {
  timestamp: number;
  signature: string;
}

function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
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

export type VerifySignatureFailureReason = "malformed_header" | "signature_mismatch" | "timestamp_out_of_tolerance";

export interface VerifySignatureResult {
  valid: boolean;
  reason?: VerifySignatureFailureReason;
}

/**
 * Re-derives the expected signature and compares constant-time
 * (`timingSafeEqualHex`, never `===`).
 */
export function verifySignature(
  payload: unknown | string,
  header: string,
  secret: string,
  options?: { toleranceSeconds?: number; now?: number },
): VerifySignatureResult {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { valid: false, reason: "malformed_header" };

  const expected = createHmac("sha256", secret)
    .update(`${parsed.timestamp}.${getPayloadString(payload)}`)
    .digest("hex");

  if (!timingSafeEqualHex(expected, parsed.signature)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  const now = options?.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options?.toleranceSeconds ?? 300;
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }

  return { valid: true };
}