/**
 * E-280 — read `sales_invoices.attention_reason` back apart.
 *
 * The scanner builds its flags as a `string[]` and stores them as one joined
 * sentence (`formatSalesAttention` in validateSalesInvoice.ts). That was fine
 * when the panel printed the sentence verbatim, and useless the moment anyone
 * had to triage 18 rows: three unrelated problems — arithmetic, a filing month,
 * an entity mismatch — arrive as one amber paragraph with no way to tell which
 * of them touches the money.
 *
 * This module turns that paragraph back into labelled parts. It is deliberately
 * a READER, not a schema change: rows already exist in both databases carrying
 * only the prose, and a new column would leave every one of them unreadable.
 *
 * Pure, no I/O, so it is unit-testable under the repo's Vitest scope rule — and
 * it is tested against the exact strings validateSalesInvoice.ts emits, so a
 * reworded template fails a test instead of silently degrading the panel.
 */

export type AttentionCode =
  | "arithmetic_mismatch"
  | "arithmetic_unverifiable"
  | "currency_not_inr"
  | "possible_duplicate"
  | "missing_date"
  | "missing_number"
  | "date_folder_mismatch"
  | "missing_customer"
  | "missing_seller_gstin"
  | "entity_conflict"
  | "entity_unknown"
  | "other";

/**
 * `amount` = the money on this row may be wrong, so revenue may be wrong.
 * `filing` = the row is counted correctly; its metadata is untidy.
 */
export type AttentionSeverity = "amount" | "filing";

export interface AttentionReason {
  code: AttentionCode;
  severity: AttentionSeverity;
  /** Short chip text. Sentence case — this is a label, not a sentence. */
  label: string;
  /** The scanner's original wording, kept verbatim for the expanded row. */
  detail: string;
}

interface AttentionMeta {
  severity: AttentionSeverity;
  label: string;
}

/**
 * Why `missing_date` and `missing_number` sit on the amount side, when they
 * look like metadata:
 *
 *   A row with no date falls outside every date-filtered revenue window, so it
 *   appears in no report at all — sandbox carries two such rows worth ₹4.85 L.
 *   A row with no number cannot be de-duplicated against zoho_invoices, and
 *   that number match is the only guard against counting an invoice twice.
 *
 * Both are money problems wearing a metadata costume.
 */
export const ATTENTION_META: Record<AttentionCode, AttentionMeta> = {
  arithmetic_mismatch: { severity: "amount", label: "Totals don't add up" },
  arithmetic_unverifiable: { severity: "amount", label: "Total unchecked" },
  currency_not_inr: { severity: "amount", label: "Not in rupees" },
  possible_duplicate: { severity: "amount", label: "Possible duplicate" },
  missing_date: { severity: "amount", label: "No date" },
  missing_number: { severity: "amount", label: "No invoice number" },
  date_folder_mismatch: { severity: "filing", label: "Filed under another month" },
  missing_customer: { severity: "filing", label: "No customer" },
  missing_seller_gstin: { severity: "filing", label: "Entity inferred" },
  entity_conflict: { severity: "filing", label: "Entity signals disagree" },
  entity_unknown: { severity: "filing", label: "Entity unknown" },
  other: { severity: "filing", label: "Needs a look" },
};

/**
 * The opening words of every template the scanner can emit, from
 * validateSalesInvoice.ts and driveSalesScan.ts's processFile.
 *
 * Order does not matter — matches are resolved longest-first at each position —
 * but the two "Sub-total" entries are why that rule exists: the unverifiable
 * message starts with the mismatch message's anchor.
 */
const ANCHORS: ReadonlyArray<{ code: AttentionCode; prefix: string }> = [
  { code: "arithmetic_unverifiable", prefix: "Sub-total or tax could not be read" },
  { code: "arithmetic_mismatch", prefix: "Sub-total " },
  { code: "currency_not_inr", prefix: "Currency read as " },
  { code: "date_folder_mismatch", prefix: "Invoice date " },
  { code: "missing_date", prefix: "No invoice date could be read" },
  { code: "missing_number", prefix: "No invoice number could be read" },
  { code: "missing_customer", prefix: "No customer name could be read" },
  { code: "missing_seller_gstin", prefix: "No seller GSTIN could be read" },
  { code: "entity_conflict", prefix: "Entity signals disagree (" },
  { code: "entity_unknown", prefix: "Could not tell which iTarang entity" },
  { code: "possible_duplicate", prefix: "Possible duplicate of " },
];

function reason(code: AttentionCode, detail: string): AttentionReason {
  return { code, severity: ATTENTION_META[code].severity, label: ATTENTION_META[code].label, detail };
}

/**
 * Split one stored `attention_reason` into its parts.
 *
 * WHY ANCHOR SCANNING AND NOT SENTENCE SPLITTING
 *   `split(". ")` looks right and is wrong twice over. The duplicate warning is
 *   two sentences inside ONE reason ("…the same ₹381035.62. Confirm before
 *   trusting this row."), so splitting tears it in half; and any future template
 *   containing a full stop would break the same way. Scanning for the known
 *   openings and cutting between them is bounded by what the scanner can
 *   actually say.
 *
 * Anything unrecognised — text before the first anchor, or a string that matches
 * nothing — comes back as one `other` reason carrying the raw text. A template
 * this file has not been taught still reaches the reader; it just arrives
 * unlabelled, which is exactly today's behaviour rather than a disappearance.
 */
export function parseAttentionReasons(raw: string | null | undefined): AttentionReason[] {
  const text = (raw ?? "").trim();
  if (!text) return [];

  const hits: Array<{ index: number; length: number; code: AttentionCode }> = [];
  for (const { code, prefix } of ANCHORS) {
    for (let from = 0; ; ) {
      const at = text.indexOf(prefix, from);
      if (at < 0) break;
      // Only at the start, or immediately after the previous reason's full
      // stop. Without this a customer name quoted inside one reason could open
      // a phantom second one.
      if (at === 0 || text.slice(at - 2, at) === ". ") {
        hits.push({ index: at, length: prefix.length, code });
      }
      from = at + 1;
    }
  }

  // Earliest first; at the same position the longest anchor wins, which is what
  // separates "Sub-total or tax could not be read" from "Sub-total ".
  hits.sort((a, b) => a.index - b.index || b.length - a.length);

  const starts: typeof hits = [];
  for (const hit of hits) {
    if (starts.length === 0 || starts[starts.length - 1].index !== hit.index) starts.push(hit);
  }

  if (starts.length === 0) return [reason("other", text)];

  const out: AttentionReason[] = [];
  if (starts[0].index > 0) {
    const preamble = text.slice(0, starts[0].index).trim();
    if (preamble) out.push(reason("other", preamble));
  }
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : text.length;
    const detail = text.slice(start.index, end).trim();
    if (detail) out.push(reason(start.code, detail));
  });
  return out;
}

/** True when any part of this flag could mean the row's money is wrong. */
export function hasAmountConcern(reasons: AttentionReason[]): boolean {
  return reasons.some((r) => r.severity === "amount");
}

/**
 * Rejoin reasons into the stored form. The inverse of the split, so a caller
 * that drops one reason (the backfill, dropping a false arithmetic warning) can
 * write the remainder back in exactly the shape the scanner would have written.
 */
export function formatAttentionReasons(reasons: AttentionReason[]): string | null {
  if (reasons.length === 0) return null;
  return reasons.map((r) => r.detail).join(" ");
}
