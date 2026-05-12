/**
 * BRD §6.0.4 — required NBFC compliance documents.
 *
 * Each Required=Yes document_type from the BRD MUST exist in
 * nbfc_compliance_documents with status='verified' before E-001's final
 * approval gate releases. The two Required=No types (NACH mandate, Recovery
 * SOP) are NOT included — uploading them is optional.
 *
 * Slugs match the vocabulary used by the compliance-doc workflow (E-005).
 */
export const REQUIRED_NBFC_DOC_TYPES: readonly string[] = [
  "rbi_cor",
  "incorporation_certificate",
  "pan_card",
  "gst_certificate",
  "audited_financials",
  "board_resolution",
  "fair_practices_code",
  "kyc_policy",
  "lsp_agreement_executed",
] as const;

export type RequiredNbfcDocType = (typeof REQUIRED_NBFC_DOC_TYPES)[number];
