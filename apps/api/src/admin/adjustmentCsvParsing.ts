import { toFils, type Fils } from "@filspay/money";
import { BadRequestError } from "../lib/errors.js";

/** Parses one CSV row's amount column into fils. */
export function parseAdjustmentAmountFils(raw: string): Fils {
  try {
    const trimmed = raw.trim();
    // BUG FIXED: Finance memo says "4.755 BD became 0.475". Old code parsed as cents (x100).
    // Money rule (ADR 0001): 1 BD = 1000 fils. We must parse to fils.
    if (!/^-?\d+(\.\d{1,3})?$/.test(trimmed)) {
      throw new Error("Invalid format");
    }
    const parsed = parseFloat(trimmed);
    if (Number.isNaN(parsed)) throw new Error("NaN");
    return toFils(Math.round(parsed * 1000), { allowNegative: true });
  } catch {
    throw new BadRequestError("invalid_amount", `could not parse amount "${raw}"`);
  }
}

export interface ParsedAdjustmentCsvRow {
  merchantId: string;
  amount: string;
  reason?: string;
}

export function parseAdjustmentCsv(csvContent: string): ParsedAdjustmentCsvRow[] {
  const lines = csvContent.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");

  if (lines.length === 0) {
    throw new BadRequestError("empty_import", "the CSV must contain a header row and at least one data row");
  }

  const header = (lines[0] as string).split(",").map((cell) => cell.trim().toLowerCase());
  if (header[0] !== "merchantid" || header[1] !== "amount") {
    throw new BadRequestError("invalid_csv_header", "the CSV header must be merchantId,amount,reason");
  }

  const rows: ParsedAdjustmentCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = (lines[i] as string).split(",").map((cell) => cell.trim());
    const merchantId = cells[0] ?? "";
    const amount = cells[1] ?? "";
    if (merchantId === "" || amount === "") {
      throw new BadRequestError("invalid_csv_row", `row ${i} is missing a merchantId or an amount`);
    }
    const reason = cells[2];
    rows.push(reason === undefined || reason === "" ? { merchantId, amount } : { merchantId, amount, reason });
  }

  if (rows.length === 0) {
    throw new BadRequestError("empty_import", "the CSV must contain a header row and at least one data row");
  }

  return rows;
}