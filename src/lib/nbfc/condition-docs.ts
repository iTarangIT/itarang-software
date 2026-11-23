/**
 * E-393 — "Approve with conditions" document list (Battery Pool, 23 Nov 2026).
 *
 * The CIBIL approver picks, from a multi-select, the documents the approval is
 * conditional on (RC, co-borrower papers …). Pure + client-safe: the panel
 * renders the list and the server validates keys against it, then raises the
 * picked documents as an additional-documents request (one per party) through
 * the normal NBFC → admin → dealer loop.
 */

export type ConditionDocFor = "primary" | "co_borrower";

export interface ConditionDoc {
  key: string;
  label: string;
  docFor: ConditionDocFor;
}

export const CONDITION_DOCS: readonly ConditionDoc[] = [
  { key: "rc_copy", label: "RC Copy", docFor: "primary" },
  { key: "bank_statement", label: "Bank Statement (3 months)", docFor: "primary" },
  { key: "cancelled_cheque", label: "Cancelled Cheque", docFor: "primary" },
  { key: "address_proof", label: "Address Proof", docFor: "primary" },
  { key: "income_proof", label: "Income Proof (Salary Slips / ITR)", docFor: "primary" },
  { key: "business_proof", label: "Business Proof", docFor: "primary" },
  { key: "passport_photo", label: "Passport Size Photo", docFor: "primary" },
  { key: "cb_aadhaar", label: "Co-borrower Aadhaar (front + back)", docFor: "co_borrower" },
  { key: "cb_pan", label: "Co-borrower PAN Card", docFor: "co_borrower" },
  { key: "cb_photo", label: "Co-borrower Photo", docFor: "co_borrower" },
  { key: "cb_bank_statement", label: "Co-borrower Bank Statement (3 months)", docFor: "co_borrower" },
  { key: "cb_address_proof", label: "Co-borrower Address Proof", docFor: "co_borrower" },
  { key: "cb_cheque", label: "Co-borrower Cancelled Cheque", docFor: "co_borrower" },
  { key: "guarantor_docs", label: "Guarantor KYC documents", docFor: "co_borrower" },
] as const;

const BY_KEY = new Map(CONDITION_DOCS.map((d) => [d.key, d]));

/** Known keys only, de-duplicated, in catalogue order. */
export function normaliseConditionDocs(keys: unknown): string[] {
  if (!Array.isArray(keys)) return [];
  const wanted = new Set(keys.filter((k): k is string => typeof k === "string"));
  return CONDITION_DOCS.filter((d) => wanted.has(d.key)).map((d) => d.key);
}

export function conditionDocLabel(key: string): string {
  return BY_KEY.get(key)?.label ?? key;
}

/** Picked keys split by party — one document request is raised per group. */
export function groupConditionDocs(keys: string[]): Record<ConditionDocFor, ConditionDoc[]> {
  const out: Record<ConditionDocFor, ConditionDoc[]> = { primary: [], co_borrower: [] };
  for (const k of normaliseConditionDocs(keys)) {
    const d = BY_KEY.get(k)!;
    out[d.docFor].push(d);
  }
  return out;
}

/** The human sentence stored/shown with the approval ("RC Copy, Co-borrower PAN Card"). */
export function describeConditions(keys: string[], note: string | null): string | null {
  const labels = normaliseConditionDocs(keys).map(conditionDocLabel);
  const parts = [labels.length ? `Documents required: ${labels.join(", ")}` : null, note?.trim() || null].filter(
    (p): p is string => !!p,
  );
  return parts.length ? parts.join(". ") : null;
}
