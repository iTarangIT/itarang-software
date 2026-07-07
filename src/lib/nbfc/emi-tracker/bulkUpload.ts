/**
 * EMI Tracker bulk-upload — shared parse + validation logic.
 *
 * Pure (no DB, no I/O) so the SAME code runs client-side (instant preview) and
 * server-side (authoritative re-validation) — see:
 *   - client: _components/EmiBulkUploadModal.tsx
 *   - server: app/api/nbfc/emi-tracker/bulk-upload/route.ts
 *
 * The source spreadsheet ("EMI Collection Tech.xlsx") is WIDE and its headers
 * REPEAT ("EMI Collect Date" appears 7×), so we never key off header names for
 * the collection pairs — we take the raw header row + 2-D cell rows and resolve
 * columns POSITIONALLY (each "Nth Amount Collected" column pairs with the column
 * immediately to its right). Single-value columns (Driver Name, Battery No,
 * Total EMI Amount, Tenure, EMI Due Date …) are matched by normalised alias.
 *
 * Date handling reuses the proven parser from scripts/import-emi-collect-data.ts:
 * Excel serials AND dd/mm/yyyy strings, with a round-trip check that rejects
 * impossible dates (30 Feb, 31 Apr → null). Invalid dates become blocking cell
 * issues so the row cannot be applied.
 *
 * On commit the upload writes TWO layers (see the bulk-upload route):
 *   1. DISPLAY overrides for the EMI Tracker summary row
 *      (nbfc_emi_tracker_overrides) — borrower/emi/progress/next_due/status/dpd.
 *   2. A SCHEDULE correction: each paid collection slot flips its installment in
 *      the canonical emi_schedules to Paid/Paid-Late (via planScheduleUpdates,
 *      mirroring the per-EMI Edit route — status/paid_at/days_overdue only,
 *      audit-logged). Blank slots are never touched, so an upload can't un-pay.
 *
 * Because CDS (Credit Default Score) and PCI (Payment Consistency Index) read
 * emi_schedules, the route runs a best-effort recompute (DPD aging + CDS + PCI)
 * after commit so the portfolio / battery / lead pages don't show a stale score.
 * Canonical lead data and the installment DUE amount are still never mutated.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type LoanStatus = "active" | "overdue" | "closed";

/** A single cell/row-level validation problem, addressable in the preview UI. */
export interface CellIssue {
  column: string; // human label, e.g. "EMI Collect Date (3)"
  value: string; // the offending raw value, as shown
  message: string; // e.g. "'30/02/2026' is not a valid date"
}

/** The override values derived from one sheet row (nulls fall back to computed). */
export interface DerivedOverride {
  borrower: string | null;
  vehicleno: string | null;
  financier: string | null;
  emi: number | null;
  progress_paid: number | null;
  progress_total: number | null;
  last_paid: string | null; // YYYY-MM-DD
  next_due: string | null; // YYYY-MM-DD
  status: LoanStatus | null;
  dpd: number | null;
}

/**
 * One paid collection slot from the sheet, ready to map onto an installment.
 * `ordinal` is 1-based (1 = "1st Amount Collected"); it targets emi_seq == ordinal.
 * `date` is the cleared date (YYYY-MM-DD) or null → fall back to the installment
 * due date at apply time. `amount` is informational (the schedule write mirrors
 * the per-EMI Edit and does not change the installment's due amount).
 */
export interface ParsedCollection {
  ordinal: number;
  amount: number | null;
  date: string | null; // YYYY-MM-DD | null
}

/** One parsed sheet row (parse stage — no DB match/duplicate yet). */
export interface ParsedRow {
  rowNumber: number; // Excel row (1-based; header = row 1)
  batteryNo: string | null; // trimmed match key
  borrower: string | null;
  paidCount: number;
  collections: ParsedCollection[]; // paid slots, in ordinal order
  issues: CellIssue[]; // blocking if non-empty
  derived: DerivedOverride;
}

/** A canonical installment row, as needed to plan a schedule correction. */
export interface ScheduleRow {
  id: string;
  emi_seq: number | null;
  due_date: string; // YYYY-MM-DD
  status: string | null;
  paid_at: string | null; // ISO | YYYY-MM-DD | null
}

/** A single planned installment correction (mirrors the per-EMI Edit semantics). */
export interface ScheduleUpdate {
  emiId: string;
  emiSeq: number;
  dueDate: string; // YYYY-MM-DD
  newStatus: "paid" | "paid_late";
  newPaidAt: string; // YYYY-MM-DD
  newDaysOverdue: number;
  prevStatus: string | null;
}

/** Result of planning a row's collections against its loan's schedule. */
export interface SchedulePlan {
  updates: ScheduleUpdate[];
  /** Collection ordinals with no matching installment (reported as a soft note). */
  unmatchedOrdinals: number[];
}

const SETTLED_STATES = new Set(["paid", "paid_late"]);

/** Whole days b − a (date-only, floored, never negative). */
function dayDiff(aYmd: string, bYmd: string): number {
  const a = Date.parse(`${aYmd}T00:00:00.000Z`);
  const b = Date.parse(`${bYmd}T00:00:00.000Z`);
  return Math.max(0, Math.floor((b - a) / 86_400_000));
}

/**
 * Plan the installment corrections for one row's paid collections. Pure — takes
 * the parsed collections + the loan's current schedule and returns only the
 * installments that would actually change. Matches "Nth Amount Collected" to the
 * installment with emi_seq == N (falling back to the Nth row by order). A slot
 * whose target is already settled to the same cleared date is skipped
 * (idempotent). Blank/unpaid slots never appear here, so an upload never un-pays.
 */
export function planScheduleUpdates(
  collections: ParsedCollection[],
  schedule: ScheduleRow[],
): SchedulePlan {
  const bySeq = new Map<number, ScheduleRow>();
  schedule.forEach((s, i) => {
    const seq = s.emi_seq ?? i + 1;
    if (!bySeq.has(seq)) bySeq.set(seq, s);
  });

  const updates: ScheduleUpdate[] = [];
  const unmatchedOrdinals: number[] = [];

  for (const c of collections) {
    const target = bySeq.get(c.ordinal);
    if (!target) {
      unmatchedOrdinals.push(c.ordinal);
      continue;
    }
    // Cleared date: sheet date, else the installment's own due date (on-time).
    const paidAt = c.date ?? target.due_date;
    const daysOverdue = dayDiff(target.due_date, paidAt);
    const newStatus: "paid" | "paid_late" = daysOverdue > 0 ? "paid_late" : "paid";

    const prevPaidAt = target.paid_at ? target.paid_at.slice(0, 10) : null;
    const alreadySame =
      SETTLED_STATES.has(String(target.status)) &&
      target.status === newStatus &&
      prevPaidAt === paidAt;
    if (alreadySame) continue;

    updates.push({
      emiId: target.id,
      emiSeq: c.ordinal,
      dueDate: target.due_date,
      newStatus,
      newPaidAt: paidAt,
      newDaysOverdue: daysOverdue,
      prevStatus: target.status,
    });
  }

  return { updates, unmatchedOrdinals };
}

/**
 * Row state after the server enriches a ParsedRow with DB match/duplicate info.
 *  - ready:     matched exactly one loan, no issues → applies on commit
 *  - duplicate: matched a loan that ALREADY has override data → skipped unless
 *               the operator opts to overwrite
 *  - error:     blocked (cell issues, no match, or ambiguous match) → never applies
 */
export type RowState = "ready" | "duplicate" | "error";

/** One row in the validate/commit report returned to the client. */
export interface ReportRow {
  rowNumber: number;
  batteryNo: string | null;
  borrower: string | null;
  state: RowState;
  loanId: string | null;
  issues: CellIssue[];
  derived: DerivedOverride;
  paidCount: number;
  note: string | null; // e.g. "Already on tracker — tick to overwrite"
  /**
   * True when the ONLY problem is that no loan on the tracker matches this
   * row's battery serial (no cell issues, no ambiguous match). Such a row can
   * be force-imported as a STANDALONE, display-only tracker entry (E-183).
   */
  noLoanMatch: boolean;
  /** Installments that will flip to Paid/Paid-Late in the drawer on commit. */
  scheduleUpdateCount: number;
  /** Soft warning, e.g. "2 collection(s) have no matching EMI installment." */
  scheduleNote: string | null;
  applied?: boolean; // commit stage only
}

export interface UploadSummary {
  total: number;
  ready: number;
  duplicate: number;
  error: number;
}

// ── Normalisation helpers (lifted from scripts/import-emi-collect-data.ts) ─────

/** Excel serial → JS Date (Excel epoch = 1899-12-30 UTC). */
export function serialToDate(n: number): Date {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86_400_000);
}

/** True for a cell that carries no value. */
export function isBlank(v: unknown): boolean {
  return v == null || (typeof v === "string" && v.trim() === "");
}

/**
 * Parse a date cell: Excel serial number, JS Date, dd/mm/yyyy(-ish) OR
 * yyyy-mm-dd string. Returns null if unparseable/impossible (round-tripped so
 * 30/02/2026 → null).
 */
export function parseDate(v: unknown): Date | null {
  if (isBlank(v)) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "number") return Number.isFinite(v) ? serialToDate(v) : null;

  const s = String(v).trim();

  // ISO yyyy-mm-dd (or yyyy/mm/dd) first — distinguishes from dd/mm/yyyy by the
  // 4-digit leading group.
  const iso = s.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/);
  if (iso) {
    const [, y, mo, d] = iso;
    return roundTrip(+y, +mo, +d);
  }

  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (!m) return null;
  const day = +m[1];
  const month = +m[2];
  let year = +m[3];
  if (year < 100) year += 2000;
  return roundTrip(year, month, day);
}

/** Build a UTC date and reject impossible calendar values by round-tripping. */
function roundTrip(year: number, month: number, day: number): Date | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}

/** Date → 'YYYY-MM-DD' (UTC parts, no tz drift). */
export function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const PAID_BY_DEALER = /dealer\s*(paid|collected)/i;
const PENDING_MARKER = /^(pending|na|n\/a|-|#value!|#n\/a)$/i;

/**
 * Parse an "Amount Collected" cell.
 *  - numeric / "6300/Dealer Collected" → { paid, amount:<n> }
 *  - "Dealer paid" (no number)         → { paid, amount:null } (pay at EMI amount)
 *  - "Pending" / "#VALUE!" / blank      → { paid:false }
 *  - anything else non-numeric          → { paid:false, invalid:true }
 */
export function parseCollected(v: unknown): {
  paid: boolean;
  amount: number | null;
  invalid: boolean;
} {
  if (isBlank(v)) return { paid: false, amount: null, invalid: false };
  if (typeof v === "number") {
    return Number.isFinite(v)
      ? { paid: v > 0, amount: v > 0 ? v : null, invalid: false }
      : { paid: false, amount: null, invalid: true };
  }
  const s = String(v).trim();
  const numMatch = s.match(/(\d[\d,]*\.?\d*)/);
  const amount = numMatch ? Number(numMatch[1].replace(/,/g, "")) : null;
  if (amount != null && Number.isFinite(amount) && amount > 0) {
    return { paid: true, amount, invalid: false };
  }
  if (PAID_BY_DEALER.test(s)) return { paid: true, amount: null, invalid: false };
  if (PENDING_MARKER.test(s)) return { paid: false, amount: null, invalid: false };
  return { paid: false, amount: null, invalid: true };
}

/** Numeric cell → number or null; `invalid` when non-blank but not a number. */
export function parseNumber(v: unknown): { value: number | null; invalid: boolean } {
  if (isBlank(v)) return { value: null, invalid: false };
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? { value: n, invalid: false } : { value: null, invalid: true };
}

/** Cell → trimmed string or null. */
export function optStr(v: unknown): string | null {
  if (isBlank(v)) return null;
  return String(v).trim();
}

// ── Column resolution ─────────────────────────────────────────────────────────

const norm = (h: unknown): string => String(h ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** Aliases for the single-value columns we actually use. */
const COLUMN_ALIASES = {
  driverName: ["driver name", "borrower", "borrower name", "customer name"],
  batteryNo: [
    "battery no",
    "battery number",
    "battery serial",
    "battery serial no",
    "battery serial number",
    "vehicle no",
    "vehicleno",
    "serial",
    "serial no",
  ],
  financer: ["financer", "financier", "finance"],
  totalEmi: ["total emi amount", "emi amount", "total emi", "emi"],
  tenure: ["tenure", "tenure (months)", "tenure months", "term", "no of emis", "installments"],
  installDate: ["battery installation date", "installation date", "install date", "disbursed date"],
  emiDueDate: ["emi due date", "next due date", "due date", "next emi date", "next due"],
} as const;

type SingleKey = keyof typeof COLUMN_ALIASES;

interface ColumnMap {
  single: Record<SingleKey, number>; // -1 if not found
  collectPairs: { ordinal: number; amountIdx: number; dateIdx: number | null }[];
}

/** Resolve the header row into positional column indices. */
export function resolveColumns(header: unknown[]): ColumnMap {
  const normed = header.map(norm);
  const findIdx = (aliases: readonly string[]): number =>
    normed.findIndex((h) => aliases.includes(h));

  const single = {} as Record<SingleKey, number>;
  (Object.keys(COLUMN_ALIASES) as SingleKey[]).forEach((k) => {
    single[k] = findIdx(COLUMN_ALIASES[k]);
  });

  // Collection pairs: every "… amount collected" column, paired with the column
  // immediately to its right (its EMI Collect Date), in sheet order.
  const collectPairs: ColumnMap["collectPairs"] = [];
  normed.forEach((h, i) => {
    if (!h.includes("amount collected")) return;
    const ordMatch = h.match(/(\d+)/);
    const ordinal = ordMatch ? +ordMatch[1] : collectPairs.length + 1;
    const nextIsDate = i + 1 < normed.length && normed[i + 1].includes("date");
    collectPairs.push({ ordinal, amountIdx: i, dateIdx: nextIsDate ? i + 1 : null });
  });

  return { single, collectPairs };
}

// ── Row parsing ────────────────────────────────────────────────────────────────

/** UTC midnight for the caller's "today" (date-only comparisons). */
function todayUtcMs(today: Date): number {
  return Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
}

/**
 * Parse a whole sheet (header row + 2-D data rows) into ParsedRows.
 * `dataStartRow` is the Excel row number of the FIRST data row (default 2).
 */
export function parseEmiUploadRows(
  header: unknown[],
  rows: unknown[][],
  opts?: { today?: Date; dataStartRow?: number },
): ParsedRow[] {
  const today = opts?.today ?? new Date();
  const todayMs = todayUtcMs(today);
  const startRow = opts?.dataStartRow ?? 2;
  const cols = resolveColumns(header);

  const out: ParsedRow[] = [];

  rows.forEach((row, i) => {
    const rowNumber = startRow + i;
    const cell = (idx: number): unknown => (idx >= 0 && idx < row.length ? row[idx] : null);

    const borrower = optStr(cell(cols.single.driverName));
    const batteryNo = optStr(cell(cols.single.batteryNo));
    const financier = optStr(cell(cols.single.financer));
    const emiCell = cell(cols.single.totalEmi);
    const tenureCell = cell(cols.single.tenure);
    const installCell = cell(cols.single.installDate);
    const dueCell = cell(cols.single.emiDueDate);

    // Skip genuinely empty rows (nothing that identifies a loan).
    if (isBlank(borrower) && isBlank(batteryNo) && isBlank(emiCell) && isBlank(dueCell)) {
      return;
    }

    const issues: CellIssue[] = [];

    // Battery No is the match key — required.
    if (!batteryNo) {
      issues.push({
        column: "Battery No",
        value: "",
        message: "Battery No is required to match a loan on the tracker.",
      });
    }

    // Total EMI Amount.
    const emiParsed = parseNumber(emiCell);
    if (emiParsed.invalid) {
      issues.push({
        column: "Total EMI Amount",
        value: String(emiCell),
        message: `'${String(emiCell)}' is not a valid amount.`,
      });
    }

    // Tenure.
    const tenureParsed = parseNumber(tenureCell);
    if (tenureParsed.invalid) {
      issues.push({
        column: "Tenure",
        value: String(tenureCell),
        message: `'${String(tenureCell)}' is not a valid number.`,
      });
    }

    // Battery Installation Date — validated but not stored (informational).
    if (!isBlank(installCell) && parseDate(installCell) == null) {
      issues.push({
        column: "Battery Installation Date",
        value: String(installCell),
        message: `'${String(installCell)}' is not a valid date.`,
      });
    }

    // EMI Due Date → next_due.
    let nextDue: string | null = null;
    if (!isBlank(dueCell)) {
      const d = parseDate(dueCell);
      if (d == null) {
        issues.push({
          column: "EMI Due Date",
          value: String(dueCell),
          message: `'${String(dueCell)}' is not a valid date.`,
        });
      } else {
        nextDue = fmtDate(d);
      }
    }

    // Collection slots → paid count + latest paid date + per-slot detail.
    let paidCount = 0;
    let lastPaidMs: number | null = null;
    const collections: ParsedCollection[] = [];
    for (const pair of cols.collectPairs) {
      const amtCell = cell(pair.amountIdx);
      const c = parseCollected(amtCell);
      if (c.invalid) {
        issues.push({
          column: `Amount Collected (${pair.ordinal})`,
          value: String(amtCell),
          message: `'${String(amtCell)}' is not a valid amount.`,
        });
        continue;
      }
      if (!c.paid) continue;
      paidCount += 1;

      let slotDate: string | null = null;
      if (pair.dateIdx != null) {
        const dateCell = cell(pair.dateIdx);
        if (!isBlank(dateCell)) {
          const d = parseDate(dateCell);
          if (d == null) {
            issues.push({
              column: `EMI Collect Date (${pair.ordinal})`,
              value: String(dateCell),
              message: `'${String(dateCell)}' is not a valid date.`,
            });
          } else {
            slotDate = fmtDate(d);
            const ms = d.getTime();
            if (lastPaidMs == null || ms > lastPaidMs) lastPaidMs = ms;
          }
        }
      }
      collections.push({ ordinal: pair.ordinal, amount: c.amount, date: slotDate });
    }

    const progressTotal = tenureParsed.value != null ? Math.round(tenureParsed.value) : null;
    const progressPaid = paidCount;
    const lastPaid = lastPaidMs != null ? fmtDate(new Date(lastPaidMs)) : null;

    // Derive Status + DPD (see plan — EMI-level only; nothing to do with CDS/PCI).
    let status: LoanStatus | null = null;
    let dpd: number | null = null;
    const complete = progressTotal != null && progressTotal > 0 && progressPaid >= progressTotal;
    if (complete) {
      status = "closed";
      dpd = 0;
    } else if (nextDue != null) {
      const dueMs = Date.parse(`${nextDue}T00:00:00.000Z`);
      if (dueMs < todayMs) {
        status = "overdue";
        dpd = Math.floor((todayMs - dueMs) / 86_400_000);
      } else {
        status = "active";
        dpd = 0;
      }
    }

    out.push({
      rowNumber,
      batteryNo,
      borrower,
      paidCount,
      collections,
      issues,
      derived: {
        borrower,
        vehicleno: batteryNo,
        financier,
        emi: emiParsed.value,
        progress_paid: progressPaid,
        progress_total: progressTotal,
        last_paid: lastPaid,
        next_due: nextDue,
        status,
        dpd,
      },
    });
  });

  return out;
}

/** Normalised battery serial for matching (case/space-insensitive). */
export function normalizeSerial(v: string | null | undefined): string {
  return String(v ?? "").trim().toLowerCase();
}
