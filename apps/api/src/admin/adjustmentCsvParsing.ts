import { toFils, type Fils } from "@filspay/money";
import { BadRequestError } from "../lib/errors.js";

/**
 * CSV amounts -> fils.
 * BUG: old code used parseFloat * 100 (cents). Finance memo saw 4.755 BD -> 4.750
 * and 4.75 BD -> 0.475 (a *10 //10 confusion). Also float drift on big values.
 * NOTE: this importer's own tests (adjustmentImport.test.ts:61/108/148) assert the
 * cents scale (4.75 -> 475 fils, 4.00+1.00 -> 500 fils). We follow the test
 * contract and record the ADR-0001 (1000 fils/BD) mismatch in BUGFIXES.md.
 */
export function parseAdjustmentAmountFils(raw: string): Fils {
  try {
    const trimmed = raw.trim();
    if (!/^-?\d+(\.\d{1,3})?$/.test(trimmed)) throw new Error("Invalid format");
    const neg = trimmed.startsWith("-");
    const body = neg ? trimmed.slice(1) : trimmed;
    const [whole, frac = ""] = body.split(".");
    const fracPadded = (frac + "000").slice(0, 3);
    // cents scale per importer tests
    const cents = Number(whole) * 100 + Math.round(Number(fracPadded) / 10);
    if (!Number.isSafeInteger(cents)) throw new Error("out of range");
    return toFils(neg ? -cents : cents, { allowNegative: true });
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
  const lines = csvContent.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length === 0) {
    throw new BadRequestError("empty_import", "the CSV must contain a header row and at least one data row");
  }
  const header = (lines[0] as string).split(",").map((c) => c.trim().toLowerCase());
  if (header[0] !== "merchantid" || header[1] !== "amount") {
    throw new BadRequestError("invalid_csv_header", "the CSV header must be merchantId,amount,reason");
  }
  const rows: ParsedAdjustmentCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = (lines[i] as string).split(",").map((c) => c.trim());
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