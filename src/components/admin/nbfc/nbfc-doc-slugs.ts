/**
 * Canonical 11-slug list for NBFC Step 2 compliance documents (9 mandatory
 * + 2 optional, per BRD §6.0.4 / RBI DL Directions 2025).
 *
 * Lives in its own module — *not* inside the "use client" upload panel —
 * so server components like NbfcReviewDocumentsSection can import the
 * actual array. When a server component imports a named export from a
 * "use client" module, Next.js / Turbopack hands back a client-reference
 * proxy rather than the real runtime value, and Array methods like
 * `.filter()` fail on the proxy.
 */
export interface DocSlug {
  slug: string;
  label: string;
  required: boolean;
  needsExpiry?: boolean;
}

export const NBFC_DOC_SLUGS: ReadonlyArray<DocSlug> = [
  { slug: "rbi_cor", label: "RBI Certificate of Registration", required: true, needsExpiry: true },
  { slug: "incorporation_certificate", label: "Certificate of Incorporation", required: true },
  { slug: "pan_card", label: "Company PAN Card", required: true },
  { slug: "gst_certificate", label: "GST Registration Certificate", required: true },
  { slug: "audited_financials", label: "Audited Financials (last 2 FYs)", required: true },
  { slug: "board_resolution", label: "Board Resolution (iTarang as LSP)", required: true },
  { slug: "fair_practices_code", label: "Fair Practices Code", required: true },
  { slug: "kyc_policy", label: "KYC Policy Document", required: true },
  { slug: "lsp_agreement_executed", label: "Executed LSP Agreement (offline scan)", required: true },
  { slug: "nach_mandate_template", label: "NACH Mandate Template", required: false },
  { slug: "recovery_immobilisation_sop", label: "Recovery & Immobilisation SOP", required: false },
];
