/**
 * Bank-statement parsing and matching (BRD M13 / U9 — the STATEMENT method).
 *
 * TWO RULES GOVERN THIS FILE, AND BOTH ARE ABOUT NOT TRUSTING THE BANK FILE:
 *
 *  1. The statement is EVIDENCE, not instruction. Nothing here writes a
 *     settlement, and nothing here decides what a settlement is worth. It reads
 *     rows off a spreadsheet and, at most, raises its hand: "this ₹53,200 debit
 *     looks like BB-1024's dealer payout." A human confirms; the confirm route
 *     re-derives the amount from deal_line_locks and refuses the row if it
 *     disagrees. A suggestion is a question, never an answer.
 *
 *  2. A real bank statement is a mess. Header junk above the table, a "Total"
 *     line below it, opening/closing balance rows, ₹ symbols, "1,23,456.78 Cr",
 *     `DD/MM/YYYY` in one bank and `05-Jan-2026` in the next. So the parser is
 *     LIBERAL in what it accepts and SILENT about what it cannot read: an
 *     unparseable row is skipped, never thrown on. Throwing would mean one
 *     footer total makes a 400-row statement unimportable.
 *
 * SIGN CONVENTION (matches bank_statement_rows.amount, which is signed):
 * credits positive, debits negative. A dealer payout is money OUT of iTarang — a
 * debit, negative. A vendor receipt is money IN — a credit, positive. Storing the
 * sign rather than a direction column means a row cannot claim to be a credit
 * while carrying a debit's amount.
 */

import { sql } from "drizzle-orm";
import Papa from "papaparse";
import * as XLSX from "xlsx";

import { db } from "@/lib/db";
import { dealMoney, dealerPayout, vendorReceipt } from "./money";
import type { BuybackTx } from "./tx";

export interface StatementRow {
  /** YYYY-MM-DD. */
  txn_date: string;
  /** SIGNED rupees: credit positive, debit negative. */
  amount: number;
  /** UTR / cheque no. — the strongest match signal a bank gives us. */
  txn_ref: string | null;
  description: string | null;
}

// ---------------------------------------------------------------------------
// Column detection
//
// Every bank names its columns differently and no two agree. Rather than a
// per-bank mapping table (which would need a code change per new bank), headers
// are normalised to bare alphanumerics and matched against a candidate list,
// exact-first then substring.
// ---------------------------------------------------------------------------

const norm = (s: unknown) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const DATE_KEYS = ["date", "txndate", "transactiondate", "valuedate", "postingdate", "bookingdate"];
const AMOUNT_KEYS = ["amount", "txnamount", "transactionamount", "amt"];
const DEBIT_KEYS = ["debit", "withdrawal", "withdrawl", "paidout", "dr"];
const CREDIT_KEYS = ["credit", "deposit", "paidin", "cr"];
/** A single amount column plus a Dr/Cr flag — the third layout banks use. */
const INDICATOR_KEYS = ["drcr", "crdr", "debitcredit", "type", "transactiontype", "indicator"];
const REF_KEYS = [
  "utr",
  "refno",
  "reference",
  "referenceno",
  "chequeno",
  "chqno",
  "chequenumber",
  "txnref",
  "transactionid",
  "utrno",
  "ref",
];
const DESC_KEYS = ["narration", "description", "particulars", "details", "remarks"];

/**
 * The header whose normalised name matches one of `candidates`, exact match
 * winning over substring.
 *
 * `exclude` keeps a column out of the running even when it matches: "Closing
 * Balance" must never be read as an amount, and "Withdrawal Amt." must not be
 * grabbed by the `amt` amount-candidate when the sheet has proper debit/credit
 * columns.
 */
function pickKey(
  headers: string[],
  candidates: string[],
  exclude: string[] = [],
): string | null {
  const usable = headers.filter((h) => {
    const n = norm(h);
    return n.length > 0 && !exclude.some((e) => n.includes(e));
  });

  for (const c of candidates) {
    const exact = usable.find((h) => norm(h) === c);
    if (exact) return exact;
  }
  for (const c of candidates) {
    const partial = usable.find((h) => norm(h).includes(c));
    if (partial) return partial;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cell coercion
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * A date cell → YYYY-MM-DD, or null if it is not a date at all (which is how a
 * footer's "Total" row gets filtered out: it has no date).
 *
 * DD/MM/YYYY is assumed over MM/DD/YYYY — every bank statement this system will
 * ever see is Indian. Where the day is unambiguous (>12) the guess is checked;
 * where it is not, the Indian reading is the right prior.
 */
export function parseDateCell(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : iso(value);
  }

  // An Excel serial that slipped through without cellDates. 1900-01-01 is 1 and
  // the sheet epoch is 1899-12-30 (Lotus's leap-year bug, preserved forever).
  if (typeof value === "number") {
    if (value < 20000 || value > 80000) return null; // 1954…2119 — anything else is not a date
    const d = new Date(Date.UTC(1899, 11, 30) + value * 86_400_000);
    return Number.isNaN(d.getTime()) ? null : iso(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  const raw = String(value).trim();
  if (!raw) return null;

  // 2026-01-05 / 2026/01/05
  let m = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return build(Number(m[1]), Number(m[2]), Number(m[3]));

  // 05-Jan-2026 / 05 Jan 26
  m = raw.match(/^(\d{1,2})[-/\s]([A-Za-z]{3,})[-/\s](\d{2,4})/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (!mon) return null;
    return build(year4(Number(m[3])), mon, Number(m[1]));
  }

  // 05/01/2026 — DD/MM/YYYY.
  m = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    let day = Number(m[1]);
    let mon = Number(m[2]);
    // The one case where the Indian reading is provably wrong: a "day" above 12
    // in the second slot means the file is MM/DD.
    if (mon > 12 && day <= 12) [day, mon] = [mon, day];
    return build(year4(Number(m[3])), mon, day);
  }

  return null;
}

function year4(y: number): number {
  return y >= 100 ? y : y + 2000;
}

function build(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d);
  // Rejects 31 February and friends — new Date() rolls them forward silently.
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return iso(dt);
}

/**
 * A money cell → a number, or null.
 *
 * Handles the four things banks actually put in an amount cell: thousands
 * separators (Indian grouping included), a currency symbol, an accounting
 * negative `(1,234.00)`, and a trailing `Cr`/`Dr` token.
 */
export function parseAmountCell(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  let raw = String(value).trim();
  if (!raw || raw === "-" || raw === "—") return null;

  let sign = 1;
  if (/^\(.*\)$/.test(raw)) {
    sign = -1;
    raw = raw.slice(1, -1);
  }
  if (/\b(dr|debit)\b\.?$/i.test(raw)) sign = -1;
  if (/\b(cr|credit)\b\.?$/i.test(raw)) sign = 1;
  if (raw.startsWith("-")) sign = -sign;

  const digits = raw.replace(/[^0-9.]/g, "");
  if (!digits || digits === ".") return null;

  const n = Number(digits);
  return Number.isFinite(n) ? sign * n : null;
}

// ---------------------------------------------------------------------------
// parseStatement
// ---------------------------------------------------------------------------

/**
 * CSV or XLSX bytes → the rows we can make sense of.
 *
 * Rows without a readable date, or with a zero/unreadable amount, are DROPPED
 * rather than raising — see the file header. A zero-amount row is not a payment
 * and a balance-brought-forward line is not ours.
 */
export function parseStatement(buffer: Buffer | ArrayBuffer, filename: string): StatementRow[] {
  const lower = filename.toLowerCase();
  let raw: Record<string, unknown>[];

  if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    const text = new TextDecoder().decode(buffer as ArrayBuffer);
    raw = Papa.parse<Record<string, unknown>>(text, {
      header: true,
      skipEmptyLines: true,
    }).data;
  } else {
    // cellDates + dateNF + raw:false makes the xlsx lib hand back YYYY-MM-DD
    // strings for anything Excel still considers a date, which is the one format
    // parseDateCell cannot misread.
    const wb = XLSX.read(buffer, { cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return [];
    raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      raw: false,
      dateNF: "yyyy-mm-dd",
      defval: "",
    });
  }

  if (raw.length === 0) return [];

  // Union of keys, not just the first row's: Papa gives every row the same keys,
  // but sheet_to_json omits trailing empties on short rows.
  const headers = Array.from(new Set(raw.flatMap((r) => Object.keys(r))));

  const dateKey = pickKey(headers, DATE_KEYS);
  if (!dateKey) return []; // No date column ⇒ this is not a bank statement.

  const indicatorKey = pickKey(headers, INDICATOR_KEYS);
  const skipIndicator = indicatorKey ? [norm(indicatorKey)] : [];

  const debitKey = pickKey(headers, DEBIT_KEYS, ["balance", ...skipIndicator]);
  const creditKey = pickKey(headers, CREDIT_KEYS, ["balance", ...skipIndicator]);
  // Only consult a lone amount column when there is no debit/credit pair —
  // otherwise "Withdrawal Amt." gets picked up as "the" amount and every debit
  // in the file lands positive.
  const amountKey =
    debitKey || creditKey
      ? null
      : pickKey(headers, AMOUNT_KEYS, ["balance", ...skipIndicator]);

  if (!debitKey && !creditKey && !amountKey) return [];

  const refKey = pickKey(headers, REF_KEYS);
  const descKey = pickKey(headers, DESC_KEYS);

  const out: StatementRow[] = [];

  for (const row of raw) {
    const txn_date = parseDateCell(row[dateKey]);
    if (!txn_date) continue; // header junk, blank separator, footer total

    let amount: number | null = null;

    if (debitKey || creditKey) {
      const debit = debitKey ? parseAmountCell(row[debitKey]) : null;
      const credit = creditKey ? parseAmountCell(row[creditKey]) : null;
      // Both columns filled is a malformed row — a transaction is one or the
      // other. Skipping it is safer than guessing which one the bank meant.
      if (debit && credit) continue;
      if (debit) amount = -Math.abs(debit);
      else if (credit) amount = Math.abs(credit);
    } else if (amountKey) {
      const parsed = parseAmountCell(row[amountKey]);
      if (parsed !== null) {
        const flag = indicatorKey ? norm(row[indicatorKey]) : "";
        // The indicator column wins over any sign already on the number: a
        // sheet that says "1,200.00" + "DR" means −1200 even though the cell
        // itself is unsigned.
        if (flag.startsWith("d") || flag.startsWith("w")) amount = -Math.abs(parsed);
        else if (flag.startsWith("c") || flag.startsWith("p")) amount = Math.abs(parsed);
        else amount = parsed;
      }
    }

    if (amount === null || !Number.isFinite(amount) || amount === 0) continue;

    const ref = refKey ? String(row[refKey] ?? "").trim() : "";
    const desc = descKey ? String(row[descKey] ?? "").trim() : "";

    out.push({
      txn_date,
      amount: Math.round(amount * 100) / 100,
      txn_ref: ref || null,
      description: desc || null,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// suggestMatches
// ---------------------------------------------------------------------------

/** The minimum of a persisted bank_statement_rows row that the matcher needs. */
export interface MatchableRow {
  id: string;
  amount: number | string;
  txn_ref: string | null;
  description: string | null;
}

interface Expectation {
  deal_id: string;
  request_no: string;
  leg: "DEALER" | "VENDOR";
  /** Positive rupees. The SIGN the bank row must carry is derived from the leg. */
  amount: number;
}

const paise = (n: number) => Math.round(n * 100);

/**
 * What iTarang is still waiting to see on a bank statement.
 *
 * Only INVOICE_APPROVED deals: before the invoice is approved no money is due,
 * and after both legs settle the deal has moved on. Only legs with no settlement
 * recorded — a leg already paid is not "expected", and suggesting it would invite
 * an admin to pay a dealer twice.
 *
 * The amounts come from `dealMoney` — the same function the confirm route uses to
 * re-derive them. That is deliberate: if the suggester and the confirmer computed
 * the expected amount differently, every suggestion would be a trap, matching in
 * the list and then being refused on click.
 */
async function openExpectations(runner: BuybackTx | typeof db): Promise<Expectation[]> {
  const deals = (await runner.execute(sql`
    SELECT
      bd.id AS deal_id,
      br.request_no,
      EXISTS (SELECT 1 FROM settlement_transactions st
               WHERE st.deal_id = bd.id AND st.leg = 'DEALER') AS dealer_settled,
      EXISTS (SELECT 1 FROM settlement_transactions st
               WHERE st.deal_id = bd.id AND st.leg = 'VENDOR') AS vendor_settled
    FROM buyback_deals bd
    JOIN buyback_requests br ON br.id = bd.request_id
    WHERE bd.status = 'INVOICE_APPROVED'
  `)) as unknown as Array<{
    deal_id: string;
    request_no: string;
    dealer_settled: boolean;
    vendor_settled: boolean;
  }>;

  const out: Expectation[] = [];

  for (const d of deals) {
    const money = await dealMoney(d.deal_id, runner);
    if (money.length === 0) continue;

    if (!d.dealer_settled) {
      const payout = dealerPayout(money);
      if (payout > 0) {
        out.push({ deal_id: d.deal_id, request_no: d.request_no, leg: "DEALER", amount: payout });
      }
    }

    if (!d.vendor_settled) {
      const receipt = vendorReceipt(money);
      // Null until a vendor has agreed a price. There is nothing to expect yet.
      if (receipt !== null && receipt > 0) {
        out.push({ deal_id: d.deal_id, request_no: d.request_no, leg: "VENDOR", amount: receipt });
      }
    }
  }

  return out;
}

/** Does the row's text name the request? 'NEFT/BB-1024/ACME' → BB-1024. */
function mentionsRequest(row: MatchableRow, requestNo: string): boolean {
  const needle = requestNo.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!needle) return false;
  const hay = `${row.txn_ref ?? ""} ${row.description ?? ""}`.toLowerCase().replace(/[^a-z0-9]/g, "");
  return hay.includes(needle);
}

export interface SuggestionResult {
  row_id: string;
  deal_id: string;
  request_no: string;
  leg: "DEALER" | "VENDOR";
}

/**
 * Raise a hand over each row that looks like a settlement we are owed or owe.
 *
 * A row is suggested only when exactly ONE open expectation fits:
 *
 *   · the amount matches to the paisa (the bank does not round, and neither do
 *     we — a ₹53,199 debit against a ₹53,200 payout is not this payment),
 *   · the SIGN agrees with the leg (a dealer payout is money out; a credit can
 *     never be one, however right the number looks), and
 *   · nothing else fits equally well.
 *
 * If two open deals happen to owe the same amount, the reference or narration is
 * consulted for a request number; if that does not break the tie, the row is left
 * UNMATCHED. An ambiguous suggestion is worse than none — it is the one an admin
 * clicks through without reading.
 *
 * NEVER AUTO-APPLIES. It writes `status='SUGGESTED'` and the two `suggested_*`
 * columns, and nothing else. The settlement is created by the confirm route, by a
 * human, against a server-derived amount.
 */
export async function suggestMatches(
  rows: MatchableRow[],
  runner: BuybackTx | typeof db = db,
): Promise<SuggestionResult[]> {
  if (rows.length === 0) return [];

  const expectations = await openExpectations(runner);
  if (expectations.length === 0) return [];

  const results: SuggestionResult[] = [];
  // One expectation, one suggestion. Two identical debits in a statement must not
  // both point at the same payout — that is how a leg gets paid twice.
  const claimed = new Set<string>();

  for (const row of rows) {
    const amount = Number(row.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;

    const leg: "DEALER" | "VENDOR" = amount < 0 ? "DEALER" : "VENDOR";
    const magnitude = paise(Math.abs(amount));

    const fits = expectations.filter(
      (e) =>
        e.leg === leg &&
        paise(e.amount) === magnitude &&
        !claimed.has(`${e.deal_id}:${e.leg}`),
    );

    let pick: Expectation | undefined;
    if (fits.length === 1) {
      pick = fits[0];
    } else if (fits.length > 1) {
      const named = fits.filter((e) => mentionsRequest(row, e.request_no));
      if (named.length === 1) pick = named[0];
      // Still ambiguous ⇒ no suggestion. Leave it for a human to read.
    }

    if (!pick) continue;

    claimed.add(`${pick.deal_id}:${pick.leg}`);

    await runner.execute(sql`
      UPDATE bank_statement_rows
         SET status = 'SUGGESTED',
             suggested_deal_id = ${pick.deal_id}::uuid,
             suggested_leg = ${pick.leg}::buyback_leg
       WHERE id = ${row.id}::uuid
         AND status = 'UNMATCHED'
    `);

    results.push({
      row_id: row.id,
      deal_id: pick.deal_id,
      request_no: pick.request_no,
      leg: pick.leg,
    });
  }

  return results;
}
