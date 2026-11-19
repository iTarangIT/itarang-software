/**
 * E-392 — Battery Pool diagram 1, part 3: which customer KYC documents are
 * asked, and which may be skipped. Pure (unit-tested in
 * __tests__/customer-doc-rules.test.ts); the DB / settings side is in
 * ./customer-doc-config.ts.
 *
 *  - Aadhaar front, Aadhaar back and PAN are ALWAYS asked and can never be
 *    skipped (the mobile number is the lead's own phone, captured at Step 1).
 *  - The iTarang sales head turns the rest on or off. An asked document is
 *    satisfied by an upload OR a skip with a reason.
 *  - Address proof and bank statement are web-only (the WhatsApp reader does
 *    not recognise them): on WhatsApp they are listed as "add on the portal, or
 *    skip with a reason".
 *
 * Keys are kyc_documents.doc_type values; `wa` is the WhatsApp flow's own name.
 */

export interface CustomerDocDef {
  key: string;
  label: string;
  /** WhatsApp customer-doc type (orchestrator), or null when WhatsApp cannot collect it. */
  wa: string | null;
  mandatory: boolean;
  /** Asked by default when the sales head has not saved a list yet. */
  defaultOn: boolean;
}

export const CUSTOMER_DOC_CATALOGUE: readonly CustomerDocDef[] = [
  { key: "aadhaar_front", label: "Aadhaar (front)", wa: "aadhaar_front", mandatory: true, defaultOn: true },
  { key: "aadhaar_back", label: "Aadhaar (back)", wa: "aadhaar_back", mandatory: true, defaultOn: true },
  { key: "pan_card", label: "PAN card", wa: "pan_card", mandatory: true, defaultOn: true },
  { key: "passport_photo", label: "Passport-size photo", wa: "customer_photo", mandatory: false, defaultOn: true },
  { key: "rc_copy", label: "RC copy", wa: "rc_copy", mandatory: false, defaultOn: true },
  { key: "cheque_1", label: "Cancelled cheque / passbook", wa: "cancelled_cheque", mandatory: false, defaultOn: false },
  { key: "address_proof", label: "Address proof", wa: null, mandatory: false, defaultOn: false },
  { key: "bank_statement", label: "Bank statement", wa: null, mandatory: false, defaultOn: false },
] as const;

export const MANDATORY_CUSTOMER_DOCS = CUSTOMER_DOC_CATALOGUE.filter((d) => d.mandatory).map((d) => d.key);
export const CONFIGURABLE_CUSTOMER_DOCS = CUSTOMER_DOC_CATALOGUE.filter((d) => !d.mandatory).map((d) => d.key);

export type CustomerDocConfig = { enabled: string[] };

export const DEFAULT_CUSTOMER_DOC_CONFIG: CustomerDocConfig = {
  enabled: CUSTOMER_DOC_CATALOGUE.filter((d) => !d.mandatory && d.defaultOn).map((d) => d.key),
};

export function docDef(key: string): CustomerDocDef | undefined {
  return CUSTOMER_DOC_CATALOGUE.find((d) => d.key === key);
}

export function customerDocLabelFor(key: string): string {
  return docDef(key)?.label ?? key.replace(/_/g, " ");
}

/** Keeps only known configurable keys, in catalogue order. */
export function normalizeCustomerDocConfig(raw: unknown): CustomerDocConfig {
  const v = raw as { enabled?: unknown } | null | undefined;
  if (!v || !Array.isArray(v.enabled)) return { ...DEFAULT_CUSTOMER_DOC_CONFIG, enabled: [...DEFAULT_CUSTOMER_DOC_CONFIG.enabled] };
  const set = new Set(v.enabled.filter((x): x is string => typeof x === "string"));
  return { enabled: CONFIGURABLE_CUSTOMER_DOCS.filter((k) => set.has(k)) };
}

/** Every asked document (kyc doc_type keys): mandatory + enabled. */
export function askedDocs(config: CustomerDocConfig): string[] {
  const on = new Set(config.enabled);
  return CUSTOMER_DOC_CATALOGUE.filter((d) => d.mandatory || on.has(d.key)).map((d) => d.key);
}

export function canSkip(key: string): boolean {
  const d = docDef(key);
  return !!d && !d.mandatory;
}

/** Asked documents neither uploaded nor skipped. */
export function outstandingDocs(input: { asked: string[]; uploaded: Iterable<string>; skipped: Iterable<string> }): string[] {
  const up = new Set(input.uploaded);
  const sk = new Set(input.skipped);
  return input.asked.filter((k) => !up.has(k) && !(canSkip(k) && sk.has(k)));
}

/** True when every asked document is uploaded, or skipped with a reason where skipping is allowed. */
export function docsSatisfied(input: { asked: string[]; uploaded: Iterable<string>; skipped: Iterable<string> }): boolean {
  return outstandingDocs(input).length === 0;
}

export const SKIP_REASON_MIN = 3;
export const SKIP_REASON_MAX = 500;

export function validateSkip(key: string, reason: string | null | undefined): { ok: true; reason: string } | { ok: false; message: string } {
  if (!docDef(key)) return { ok: false, message: "Unknown document" };
  if (!canSkip(key)) return { ok: false, message: `${customerDocLabelFor(key)} can't be skipped — Aadhaar and PAN are mandatory.` };
  const r = (reason ?? "").trim();
  if (r.length < SKIP_REASON_MIN) return { ok: false, message: "Write why this document can't be given." };
  return { ok: true, reason: r.slice(0, SKIP_REASON_MAX) };
}

/** WhatsApp doc type → kyc doc_type key (customer_photo → passport_photo, cancelled_cheque → cheque_1). */
export function kycKeyForWa(wa: string): string {
  return CUSTOMER_DOC_CATALOGUE.find((d) => d.wa === wa)?.key ?? wa;
}
