/**
 * The documents a scrap vendor is onboarded with (E-223).
 *
 * `scrap_vendor_documents.doc_type` is free text in the DB, per this schema
 * family's convention — this module is the vocabulary, and zod at the write
 * path is the enforcement. Kept in `lib` rather than beside the route so the
 * form, the upload route and the create route cannot disagree about which
 * documents exist or which are mandatory.
 */

export const VENDOR_DOC_TYPES = ["GSTIN", "PAN", "UDYAM", "AGREEMENT"] as const;

export type VendorDocType = (typeof VENDOR_DOC_TYPES)[number];

/**
 * The three an admin must attach before a vendor can be created. AGREEMENT is
 * deliberately absent: the manual agreement is optional for now (many vendors
 * are onboarded on a handshake and the paper follows), and blocking onboarding
 * on it would just push admins into uploading a placeholder.
 */
export const REQUIRED_VENDOR_DOC_TYPES = ["GSTIN", "PAN", "UDYAM"] as const;

export const VENDOR_DOC_LABELS: Record<VendorDocType, string> = {
  GSTIN: "GST certificate",
  PAN: "PAN card",
  UDYAM: "Udyam registration certificate",
  AGREEMENT: "Signed vendor agreement",
};
