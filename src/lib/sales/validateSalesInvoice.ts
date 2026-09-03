/**
 * E-280 — deterministic checks over what the vision model read off a sales PDF.
 *
 * The Vyapar invoices have no usable text layer, so every figure on them comes
 * from a model looking at a rendered page. That is accurate but not infallible,
 * and these numbers land directly on the CEO's revenue card. The checks here
 * are the cheap, deterministic half of the answer: arithmetic that must hold,
 * and a date that must agree with the folder somebody filed it in.
 *
 * This mirrors validateExpense (src/lib/expenses/validateExpense.ts) on the
 * purchase side, including the split it draws:
 *
 *   NOT ok        → no usable total. Cannot become a row at all; a zero would
 *                   silently understate revenue, which is worse than a gap.
 *   ok + attention → the row imports AND counts, but says what looks wrong.
 *
 * The second case is deliberate. Holding revenue out of the dashboard until a
 * human clears it makes the CEO's number lag by however long the queue is; a
 * flagged row that is visible in both the total and the attention list is the
 * honest trade. A real misread found during the Step-0 probe is exactly this
 * shape: ITG_202627_41.pdf, filed under "August 2026", came back dated
 * 2023-08-13 — right day, wrong year. The month check below catches it.
 */

export interface SalesInvoiceCandidate {
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  customer_name: string | null;
  customer_gstin: string | null;
  seller_gstin: string | null;
  place_of_supply: string | null;
  sub_total: number | null;
  tax_total: number | null;
  total: number | null;
  currency: string | null;
}

export interface ValidatedSalesInvoice {
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  customer_name: string | null;
  customer_gstin: string | null;
  seller_gstin: string | null;
  place_of_supply: string | null;
  sub_total: number | null;
  tax_total: number | null;
  total: number;
}

export type ValidateSalesInvoiceResult =
  | { ok: true; value: ValidatedSalesInvoice; attention: string[] }
  | { ok: false; reason: string };

/**
 * Rupee tolerance on sub_total + tax_total = total.
 *
 * Not zero: GST is computed per line and rounded per line, so a multi-line
 * invoice legitimately lands a rupee either side of the sum of its parts.
 * Wide enough to absorb that, narrow enough that a misread digit cannot hide.
 */
const ARITHMETIC_TOLERANCE = 2;

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * "2026 / August 2026 / Sale / Haryana" → { year: 2026, month: 8 }
 *
 * Returns null when no segment names a month, which is normal — the check is
 * skipped rather than failing a file for being filed somewhere unusual.
 */
export function monthFromFolderPath(
  folderPath: string | null | undefined,
): { year: number; month: number } | null {
  if (!folderPath) return null;
  for (const segment of folderPath.split("/")) {
    const m = segment.trim().toLowerCase().match(/^([a-z]+)\s+(\d{4})$/);
    if (!m) continue;
    const idx = MONTHS.indexOf(m[1]);
    if (idx === -1) continue;
    return { year: Number(m[2]), month: idx + 1 };
  }
  return null;
}

function isIsoDate(v: string | null): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

export function validateSalesInvoice(
  candidate: SalesInvoiceCandidate,
  opts: { folderPath?: string | null } = {},
): ValidateSalesInvoiceResult {
  const attention: string[] = [];

  // --- the one hard requirement -------------------------------------------
  const total =
    typeof candidate.total === "number" && Number.isFinite(candidate.total)
      ? candidate.total
      : null;
  if (total == null || total <= 0) {
    return {
      ok: false,
      reason:
        total == null
          ? "No total could be read from this invoice."
          : `Total read as ${total}, which cannot be an invoice amount.`,
    };
  }

  // Revenue is reported in INR. A foreign-currency sales invoice is not
  // something this business issues, so treat it as a misread rather than
  // silently adding a USD figure to a rupee total.
  if (candidate.currency && candidate.currency.toUpperCase() !== "INR") {
    attention.push(
      `Currency read as ${candidate.currency}, not INR — the amount may be wrong.`,
    );
  }

  // --- arithmetic ----------------------------------------------------------
  const sub = typeof candidate.sub_total === "number" ? candidate.sub_total : null;
  const tax = typeof candidate.tax_total === "number" ? candidate.tax_total : null;
  if (sub != null && tax != null) {
    const drift = Math.abs(sub + tax - total);
    if (drift > ARITHMETIC_TOLERANCE) {
      attention.push(
        `Sub-total ${sub.toFixed(2)} + tax ${tax.toFixed(2)} = ${(sub + tax).toFixed(2)}, ` +
          `but the total reads ${total.toFixed(2)} (off by ${drift.toFixed(2)}).`,
      );
    }
  } else {
    attention.push("Sub-total or tax could not be read, so the total is unchecked.");
  }

  // --- date ----------------------------------------------------------------
  let invoiceDate: string | null = null;
  if (isIsoDate(candidate.invoice_date)) {
    invoiceDate = candidate.invoice_date;
    const folderMonth = monthFromFolderPath(opts.folderPath);
    if (folderMonth) {
      const [y, m] = invoiceDate.split("-").map(Number);
      if (y !== folderMonth.year || m !== folderMonth.month) {
        // The Step-0 probe hit exactly this: a real August 2026 invoice came
        // back dated 2023-08-13.
        attention.push(
          `Invoice date ${invoiceDate} does not match the folder it is filed in ` +
            `(${MONTHS[folderMonth.month - 1]} ${folderMonth.year}).`,
        );
      }
    }
  } else {
    attention.push("No invoice date could be read.");
  }

  // --- identity ------------------------------------------------------------
  const invoiceNumber = candidate.invoice_number?.trim() || null;
  if (!invoiceNumber) {
    // Not fatal, but it disables the number-based dedup for this row, so the
    // person reading the panel needs to know.
    attention.push(
      "No invoice number could be read — this row cannot be de-duplicated by number.",
    );
  }
  if (!candidate.customer_name?.trim()) {
    attention.push("No customer name could be read.");
  }
  if (!candidate.seller_gstin?.trim()) {
    attention.push("No seller GSTIN could be read — the entity was inferred.");
  }

  return {
    ok: true,
    value: {
      invoice_number: invoiceNumber,
      invoice_date: invoiceDate,
      due_date: isIsoDate(candidate.due_date) ? candidate.due_date : null,
      customer_name: candidate.customer_name?.trim() || null,
      customer_gstin: candidate.customer_gstin?.trim() || null,
      seller_gstin: candidate.seller_gstin?.trim() || null,
      place_of_supply: candidate.place_of_supply?.trim() || null,
      sub_total: sub,
      tax_total: tax,
      total,
    },
    attention,
  };
}

/** Join attention lines into the single column the panel renders. */
export function formatSalesAttention(attention: string[]): string | null {
  if (attention.length === 0) return null;
  return attention.join(" ");
}
