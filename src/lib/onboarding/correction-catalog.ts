// Single source of truth for what an admin can flag in a correction round and
// for what the dealer sees on the correction form. Keys here must match:
//   • field keys → column names on dealerOnboardingApplications
//   • document keys → documentType strings written by
//     src/app/api/dealer/onboarding/submit/route.ts (gst_certificate,
//     company_pan, etc.)
// Adding a key in two places (catalog + DB) is the only safe way to expose a
// new correctable item — both the admin modal and dealer form read from this
// list.

export type CorrectionFieldKey =
  | "companyName"
  | "companyType"
  | "gstNumber"
  | "panNumber"
  | "cinNumber"
  | "ownerName"
  | "ownerPhone"
  | "ownerEmail"
  | "bankName"
  | "accountNumber"
  | "beneficiaryName"
  | "ifscCode"
  | "salesManagerName"
  | "salesManagerEmail"
  | "salesManagerMobile";

export type CorrectionDocumentKey =
  | "gst_certificate"
  | "company_pan"
  | "itr_3_years"
  | "bank_statement_3_months"
  | "undated_cheques"
  | "passport_photo"
  | "udyam_certificate"
  | "owner_photo"
  | "partnership_deed"
  | "mou_document"
  | "aoa_document";

export type CorrectionField = {
  key: CorrectionFieldKey;
  label: string;
  hint?: string;
  group: "company" | "owner" | "bank" | "sales_manager";
};

export type CorrectionDocument = {
  key: CorrectionDocumentKey;
  label: string;
  hint?: string;
  group: "company" | "compliance" | "ownership";
};

export const CORRECTION_FIELDS: CorrectionField[] = [
  { key: "companyName",        label: "Company Name",            group: "company" },
  { key: "companyType",        label: "Company Type",            group: "company" },
  { key: "gstNumber",          label: "GST Number",              group: "company" },
  { key: "panNumber",          label: "PAN Number",              group: "company" },
  { key: "cinNumber",          label: "CIN Number",              group: "company", hint: "Only for private limited firms" },
  { key: "ownerName",          label: "Owner Name",              group: "owner" },
  { key: "ownerPhone",         label: "Owner Phone",             group: "owner" },
  { key: "ownerEmail",         label: "Owner Email",             group: "owner" },
  { key: "bankName",           label: "Bank Name",               group: "bank" },
  { key: "accountNumber",      label: "Account Number",          group: "bank" },
  { key: "beneficiaryName",    label: "Beneficiary Name",        group: "bank" },
  { key: "ifscCode",           label: "IFSC Code",               group: "bank" },
  { key: "salesManagerName",   label: "Sales Manager Name",      group: "sales_manager" },
  { key: "salesManagerEmail",  label: "Sales Manager Email",     group: "sales_manager" },
  { key: "salesManagerMobile", label: "Sales Manager Mobile",    group: "sales_manager" },
];

export const CORRECTION_DOCUMENTS: CorrectionDocument[] = [
  { key: "gst_certificate",         label: "GST Certificate",          group: "company" },
  { key: "company_pan",             label: "Company PAN Card",         group: "company" },
  { key: "itr_3_years",             label: "ITR (last 3 years)",       group: "compliance" },
  { key: "bank_statement_3_months", label: "Bank Statement (3 months)", group: "compliance" },
  { key: "undated_cheques",         label: "4 Undated Cheques",        group: "compliance" },
  { key: "passport_photo",          label: "Passport Photo",           group: "compliance" },
  { key: "udyam_certificate",       label: "Udyam Registration",       group: "compliance" },
  { key: "owner_photo",             label: "Owner Photo",              group: "ownership" },
  { key: "partnership_deed",        label: "Partnership Deed",         group: "ownership" },
  { key: "mou_document",            label: "MOU Document",             group: "ownership" },
  { key: "aoa_document",            label: "AOA Document",             group: "ownership" },
];

const FIELD_KEYS = new Set<string>(CORRECTION_FIELDS.map((f) => f.key));
const DOCUMENT_KEYS = new Set<string>(CORRECTION_DOCUMENTS.map((d) => d.key));

export function isCorrectionFieldKey(value: unknown): value is CorrectionFieldKey {
  return typeof value === "string" && FIELD_KEYS.has(value);
}

export function isCorrectionDocumentKey(value: unknown): value is CorrectionDocumentKey {
  return typeof value === "string" && DOCUMENT_KEYS.has(value);
}

export function fieldLabel(key: string): string {
  return CORRECTION_FIELDS.find((f) => f.key === key)?.label ?? key;
}

export function documentLabel(key: string): string {
  return CORRECTION_DOCUMENTS.find((d) => d.key === key)?.label ?? key;
}
