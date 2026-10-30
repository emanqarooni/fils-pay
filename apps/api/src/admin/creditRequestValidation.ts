import { toFils, type Fils } from "@filspay/money";
import { BadRequestError } from "../lib/errors.js";

export type CreditReasonCode = "goodwill" | "dispute_resolution" | "correction";
const REASON_CODES: readonly CreditReasonCode[] = ["goodwill", "dispute_resolution", "correction"];
const MAX_MEMO_LENGTH = 500;

export interface CreditRequestDraft {
  baseAmountFils: Fils;
  reasonCode: CreditReasonCode;
  memo: string | null;
  reverseFee: boolean;
  effectiveDate: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseCreditRequestInput(body: unknown): CreditRequestDraft {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("invalid_request", "a JSON object body is required");
  }
  const input = body as Record<string, unknown>;

  const rawAmount = input.baseAmountFils;
  if (typeof rawAmount !== "number" || !Number.isSafeInteger(rawAmount) || rawAmount <= 0) {
    throw new BadRequestError("invalid_amount", "baseAmountFils must be a positive integer number of fils");
  }
  const baseAmountFils = toFils(rawAmount);

  const rawReason = input.reasonCode;
  if (typeof rawReason !== "string" || !REASON_CODES.includes(rawReason as CreditReasonCode)) {
    throw new BadRequestError("invalid_reason_code", `reasonCode must be one of ${REASON_CODES.join(", ")}`);
  }
  const reasonCode = rawReason as CreditReasonCode;

  let memo: string | null = null;
  if (input.memo !== undefined && input.memo !== null) {
    if (typeof input.memo !== "string") {
      throw new BadRequestError("invalid_memo", "memo, if given, must be a string");
    }
    const trimmed = input.memo.trim();
    if (trimmed.length > MAX_MEMO_LENGTH) {
      throw new BadRequestError("invalid_memo", `memo must be at most ${MAX_MEMO_LENGTH} characters`);
    }
    memo = trimmed === "" ? null : trimmed;
  }

  if (input.reverseFee !== undefined && typeof input.reverseFee !== "boolean") {
    throw new BadRequestError("invalid_request", "reverseFee, if given, must be a boolean");
  }
  const reverseFee = input.reverseFee === true;

  const rawDate = input.effectiveDate;
  if (typeof rawDate !== "string" || !ISO_DATE_RE.test(rawDate) || !isRealCalendarDate(rawDate)) {
    throw new BadRequestError("invalid_effective_date", "effectiveDate must be a real calendar date formatted YYYY-MM-DD");
  }

  // BUG FIXED: Must reject future dates and dates older than 35 days.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dateObj = new Date(`${rawDate}T00:00:00Z`);
  
  if (dateObj > today) {
    throw new BadRequestError("invalid_effective_date", "effectiveDate cannot be in the future");
  }
  
  const thirtyFiveDaysAgo = new Date(today);
  thirtyFiveDaysAgo.setUTCDate(today.getUTCDate() - 35);
  if (dateObj < thirtyFiveDaysAgo) {
    throw new BadRequestError("invalid_effective_date", "effectiveDate cannot be older than 35 days");
  }

  return { baseAmountFils, reasonCode, memo, reverseFee, effectiveDate: rawDate };
}