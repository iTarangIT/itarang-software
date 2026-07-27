/**
 * E-216 — Validation between "the model said something" and "we wrote it to
 * the books".
 *
 * There is no approval step in this pipeline, so this file is the only thing
 * standing between a misread invoice and the CEO's Expenses card. Its shape
 * follows from that:
 *
 *   - ONE hard failure: no readable amount. `expense_submissions.amount` is
 *     NOT NULL, and importing a zero would quietly understate spend while
 *     looking like a successful import. Those files stop at a
 *     drive_expense_files row and stay visible in the needs-attention panel.
 *
 *   - EVERYTHING ELSE is a flag, not a block. A bill with a readable ₹1.2L but
 *     no vendor name is still ₹1.2L of real spend; withholding it makes the
 *     dashboard wrong in the direction nobody notices. It imports, it counts,
 *     and it carries a reason so a human can finish it.
 *
 * The same design rule the OCR field validators state
 * (src/lib/ocr/aadhaarFieldValidators.ts:7-9) applies to the non-amount
 * fields: drop a value we are not confident in rather than pass it through.
 */
import {
  EXPENSE_DEPARTMENT_VALUES,
  type ExpenseDepartment,
} from "@/lib/expenses";

/** Matches the zod bound already enforced in api/admin/ai-expenses/route.ts. */
const MAX_AMOUNT = 100_000_000;

/** Invoices older than this are almost certainly a misread year. */
const MIN_YEAR = 2015;

/** Below this the model is guessing at the department; fall back and flag. */
const MIN_DEPARTMENT_CONFIDENCE = 0.5;

export interface ExpenseCandidate {
  vendor: string | null;
  amount: number | null;
  currency: string | null;
  date: string | null;
  description: string | null;
  department: string | null;
  project_tag: string | null;
  department_confidence?: number | null;
  invoice_number?: string | null;
}

export interface ValidatedExpense {
  vendor: string | null;
  amount: number;
  currency: string | null;
  /** ISO yyyy-mm-dd, or null when the source date was unusable. */
  expense_date: string | null;
  description: string | null;
  department: ExpenseDepartment;
  project_tag: string | null;
  invoice_number: string | null;
}

export type ValidateResult =
  | { ok: true; value: ValidatedExpense; attention: string[] }
  | { ok: false; reason: string };

/**
 * Validate one extracted expense.
 *
 * `opts.requireInvoiceNumber` is false for spreadsheet rows: cost lines in a
 * sheet legitimately have no invoice number of their own, and flagging every
 * one of them would bury the genuinely broken rows.
 */
export function validateExpense(
  candidate: ExpenseCandidate,
  opts: { requireInvoiceNumber?: boolean } = {},
): ValidateResult {
  const requireInvoiceNumber = opts.requireInvoiceNumber ?? true;
  const attention: string[] = [];

  // --- amount: the only hard failure ---------------------------------------
  const amount = candidate.amount;
  if (amount == null || !Number.isFinite(amount)) {
    return { ok: false, reason: "No amount could be read from this document." };
  }
  if (amount <= 0) {
    return {
      ok: false,
      reason: `Amount read as ${amount}, which is not a positive number.`,
    };
  }
  if (amount > MAX_AMOUNT) {
    return {
      ok: false,
      reason: `Amount read as ${amount.toLocaleString(
        "en-IN",
      )}, which exceeds the ₹10 crore sanity limit — almost certainly a misread.`,
    };
  }
  // Two decimal places, matching numeric(14,2).
  const roundedAmount = Math.round(amount * 100) / 100;

  // --- date -----------------------------------------------------------------
  const dateResult = validateExpenseDate(candidate.date);
  if (dateResult.flag) attention.push(dateResult.flag);

  // --- vendor ---------------------------------------------------------------
  const vendor = trimOrNull(candidate.vendor, 160);
  if (!vendor) attention.push("No vendor name was found.");

  // --- department -----------------------------------------------------------
  const rawDept = candidate.department;
  let department: ExpenseDepartment;
  if (rawDept && EXPENSE_DEPARTMENT_VALUES.includes(rawDept as ExpenseDepartment)) {
    department = rawDept as ExpenseDepartment;
    const confidence = candidate.department_confidence;
    if (typeof confidence === "number" && confidence < MIN_DEPARTMENT_CONFIDENCE) {
      attention.push(
        `Department "${department}" was a low-confidence guess (${Math.round(
          confidence * 100,
        )}%).`,
      );
    }
  } else {
    // Same fallback the existing bulk import uses, so a Drive row and a
    // hand-uploaded row behave identically.
    department = "ops";
    attention.push('Department could not be determined — filed under "ops".');
  }

  // --- currency -------------------------------------------------------------
  // E-217 — no longer a warning. The caller converts to INR before storing, so
  // a foreign invoice is a normal expense; only a FAILED conversion is worth a
  // human's time, and that flag is raised by the converter itself.
  const currency = trimOrNull(candidate.currency, 8)?.toUpperCase() ?? null;

  // --- invoice number -------------------------------------------------------
  const invoiceNumber = trimOrNull(candidate.invoice_number, 120);
  if (requireInvoiceNumber && !invoiceNumber) {
    attention.push(
      "No invoice number was found — this row cannot be de-duplicated against future imports.",
    );
  }

  return {
    ok: true,
    value: {
      vendor,
      amount: roundedAmount,
      currency,
      expense_date: dateResult.value,
      description: trimOrNull(candidate.description, 2000),
      department,
      project_tag: trimOrNull(candidate.project_tag, 80),
      invoice_number: invoiceNumber,
    },
    attention,
  };
}

/**
 * A date is never worth failing an import over — a real ₹50k bill with an
 * unreadable date is still a real ₹50k bill. Return null and flag instead.
 */
function validateExpenseDate(raw: string | null): {
  value: string | null;
  flag: string | null;
} {
  if (!raw) return { value: null, flag: "No invoice date was found." };

  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    return { value: null, flag: `Invoice date "${raw}" was not a usable date.` };
  }

  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];

  // JS rolls 2024-02-31 forward to 2024-03-02 without complaint. Round-trip
  // through UTC to catch it — the same guard parseDob uses in the KYC OCR path.
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return { value: null, flag: `Invoice date "${raw}" is not a real calendar date.` };
  }

  if (year < MIN_YEAR) {
    return {
      value: null,
      flag: `Invoice date "${raw}" is before ${MIN_YEAR} — most likely a misread year.`,
    };
  }

  // One day of slack absorbs timezone edges between the server and the bill.
  const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
  if (d.getTime() > tomorrow) {
    return { value: null, flag: `Invoice date "${raw}" is in the future.` };
  }

  return { value: raw.trim(), flag: null };
}

function trimOrNull(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

/** Join flags into the single sentence stored in `attention_reason`. */
export function formatAttentionReason(attention: string[]): string | null {
  if (attention.length === 0) return null;
  return attention.join(" ");
}
