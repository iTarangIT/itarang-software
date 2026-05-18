/**
 * Stable target-key catalog for CEO per-item correction requests (E-111).
 *
 * Each `target_key` is a string the CEO's "Request Corrections" payload
 * carries to identify which field/doc/signer/agreement is being flagged.
 * Keys are deliberately strings (not row ids) so a doc re-upload — which
 * creates a fresh `nbfc_compliance_documents.id` — still resolves the same
 * flagged item.
 */

import { NBFC_DOC_SLUGS } from "@/components/admin/nbfc/nbfc-doc-slugs";

export const CORRECTION_KINDS = [
  "master_field",
  "compliance_doc",
  "signer_field",
  "signer_identity_doc",
  "agreement_template",
] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];

export const MASTER_FIELD_KEYS = {
  legal_name: "Legal name",
  short_name: "Short name",
  rbi_registration_no: "RBI registration number",
  cin: "CIN",
  gst_number: "GST number",
  pan_number: "PAN number",
  nbfc_type: "NBFC type",
  partnership_date: "Partnership date",
  cor_expiry_date: "CoR expiry date",
  registered_address: "Registered address",
  active_geographies: "Active geographies",
  primary_contact_name: "Primary contact · Name",
  primary_contact_email: "Primary contact · Email",
  primary_contact_phone: "Primary contact · Phone",
  grievance_officer_name: "Grievance redressal officer",
  grievance_helpline: "Grievance helpline",
  grievance_url: "Grievance URL",
  nodal_officer: "Nodal officer",
} as const;
export type MasterFieldKey = keyof typeof MASTER_FIELD_KEYS;

export const COMPLIANCE_DOC_KEYS = Object.fromEntries(
  NBFC_DOC_SLUGS.map((d) => [d.slug, d.label] as const),
) as Record<string, string>;

export const SIGNER_SUBFIELDS = ["full_name", "email", "designation"] as const;
export type SignerSubfield = (typeof SIGNER_SUBFIELDS)[number];

const SIGNER_SUBFIELD_LABELS: Record<SignerSubfield, string> = {
  full_name: "Name",
  email: "Email",
  designation: "Designation",
};

export function signerFieldKey(
  party: string,
  signerOrder: number,
  field: SignerSubfield,
): string {
  return `signer:${party}:${signerOrder}:${field}`;
}

export function signerIdentityDocKey(
  party: string,
  signerOrder: number,
): string {
  return `signer_identity:${party}:${signerOrder}`;
}

export const AGREEMENT_TEMPLATE_KEY = "agreement_template";

/** Parse a composite signer key back to its parts (returns null if not a signer key). */
export function parseSignerKey(
  key: string,
):
  | { party: string; signerOrder: number; field: SignerSubfield | "identity" }
  | null {
  if (key.startsWith("signer:")) {
    const [, party, orderStr, field] = key.split(":");
    if (!party || !orderStr || !field) return null;
    const order = Number.parseInt(orderStr, 10);
    if (!Number.isFinite(order)) return null;
    if (!(SIGNER_SUBFIELDS as readonly string[]).includes(field)) return null;
    return { party, signerOrder: order, field: field as SignerSubfield };
  }
  if (key.startsWith("signer_identity:")) {
    const [, party, orderStr] = key.split(":");
    if (!party || !orderStr) return null;
    const order = Number.parseInt(orderStr, 10);
    if (!Number.isFinite(order)) return null;
    return { party, signerOrder: order, field: "identity" };
  }
  return null;
}

/** Resolve a human-readable label for any (kind, target_key) pair. */
export function labelFor(kind: CorrectionKind, targetKey: string): string {
  switch (kind) {
    case "master_field":
      return (
        MASTER_FIELD_KEYS[targetKey as MasterFieldKey] ?? targetKey
      );
    case "compliance_doc":
      return COMPLIANCE_DOC_KEYS[targetKey] ?? targetKey;
    case "signer_field": {
      const parsed = parseSignerKey(targetKey);
      if (!parsed || parsed.field === "identity") return targetKey;
      const partyLabel = parsed.party === "nbfc" ? "NBFC" : "iTarang";
      return `${partyLabel} signer #${parsed.signerOrder} · ${SIGNER_SUBFIELD_LABELS[parsed.field as SignerSubfield]}`;
    }
    case "signer_identity_doc": {
      const parsed = parseSignerKey(targetKey);
      if (!parsed) return targetKey;
      const partyLabel = parsed.party === "nbfc" ? "NBFC" : "iTarang";
      return `${partyLabel} signer #${parsed.signerOrder} · Identity document`;
    }
    case "agreement_template":
      return "LSP agreement template";
  }
}

/** Validate a (kind, target_key) pair. Returns null when invalid. */
export function validateTargetKey(
  kind: CorrectionKind,
  targetKey: string,
): { ok: true } | { ok: false; reason: string } {
  switch (kind) {
    case "master_field":
      return targetKey in MASTER_FIELD_KEYS
        ? { ok: true }
        : { ok: false, reason: `unknown master_field key: ${targetKey}` };
    case "compliance_doc":
      return targetKey in COMPLIANCE_DOC_KEYS
        ? { ok: true }
        : { ok: false, reason: `unknown compliance_doc slug: ${targetKey}` };
    case "signer_field": {
      const p = parseSignerKey(targetKey);
      if (!p || p.field === "identity")
        return { ok: false, reason: `invalid signer_field key: ${targetKey}` };
      return { ok: true };
    }
    case "signer_identity_doc": {
      const p = parseSignerKey(targetKey);
      if (!p || p.field !== "identity")
        return {
          ok: false,
          reason: `invalid signer_identity_doc key: ${targetKey}`,
        };
      return { ok: true };
    }
    case "agreement_template":
      return targetKey === AGREEMENT_TEMPLATE_KEY
        ? { ok: true }
        : { ok: false, reason: `agreement_template key must be "${AGREEMENT_TEMPLATE_KEY}"` };
  }
}

/** Section grouping used by the admin outstanding-corrections panel. */
export type CorrectionSection =
  | "master_details"
  | "compliance_documents"
  | "agreement";

export function sectionFor(kind: CorrectionKind): CorrectionSection {
  switch (kind) {
    case "master_field":
      return "master_details";
    case "compliance_doc":
      return "compliance_documents";
    case "signer_field":
    case "signer_identity_doc":
    case "agreement_template":
      return "agreement";
  }
}

export const SECTION_LABELS: Record<CorrectionSection, string> = {
  master_details: "Master details",
  compliance_documents: "Compliance documents",
  agreement: "Signatories & Agreement",
};
