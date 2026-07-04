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
  | "companyAddress"
  | "companyType"
  | "gstNumber"
  | "panNumber"
  | "cinNumber"
  | "ownerName"
  | "ownerPhone"
  | "ownerEmail"
  | "ownerAddressLine1"
  | "ownerCity"
  | "ownerDistrict"
  | "ownerState"
  | "ownerPinCode"
  | "bankName"
  | "accountNumber"
  | "beneficiaryName"
  | "ifscCode"
  | "bankBranch"
  | "accountType"
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

// Where a field's value is actually persisted on dealer_onboarding_applications.
// Most fields are plain columns, but some live inside JSON blobs (the company
// address text/JSON, and the snapshot ownership object). request-correction and
// apply-correction route reads/writes by this descriptor.
export type CorrectionFieldStore =
  | { kind: "column"; column: string }
  | { kind: "businessAddress" } // business_address TEXT column, JSON { address }
  | { kind: "snapshotOwnership"; snapshotKey: string }; // provider_raw_response.submissionSnapshot.ownership[snapshotKey]

export type CorrectionField = {
  key: CorrectionFieldKey;
  label: string;
  hint?: string;
  group: "company" | "owner" | "address" | "bank" | "sales_manager";
  store: CorrectionFieldStore;
};

export type CorrectionDocument = {
  key: CorrectionDocumentKey;
  label: string;
  hint?: string;
  group: "company" | "compliance" | "ownership";
};

export const CORRECTION_FIELDS: CorrectionField[] = [
  { key: "companyName",        label: "Company Name",            group: "company", store: { kind: "column", column: "company_name" } },
  { key: "companyAddress",     label: "Company Address",         group: "company", store: { kind: "businessAddress" } },
  { key: "companyType",        label: "Company Type",            group: "company", store: { kind: "column", column: "company_type" } },
  { key: "gstNumber",          label: "GST Number",              group: "company", store: { kind: "column", column: "gst_number" } },
  { key: "panNumber",          label: "PAN Number",              group: "company", store: { kind: "column", column: "pan_number" } },
  { key: "cinNumber",          label: "CIN Number",              group: "company", hint: "Only for private limited firms", store: { kind: "column", column: "cin_number" } },
  { key: "ownerName",          label: "Owner Name",              group: "owner", store: { kind: "column", column: "owner_name" } },
  { key: "ownerPhone",         label: "Owner Phone",             group: "owner", store: { kind: "column", column: "owner_phone" } },
  { key: "ownerEmail",         label: "Owner Email",             group: "owner", store: { kind: "column", column: "owner_email" } },
  { key: "ownerAddressLine1",  label: "Address Line 1",          group: "address", store: { kind: "snapshotOwnership", snapshotKey: "ownerAddressLine1" } },
  { key: "ownerCity",          label: "City",                    group: "address", store: { kind: "snapshotOwnership", snapshotKey: "ownerCity" } },
  { key: "ownerDistrict",      label: "District",                group: "address", store: { kind: "snapshotOwnership", snapshotKey: "ownerDistrict" } },
  { key: "ownerState",         label: "State",                   group: "address", store: { kind: "snapshotOwnership", snapshotKey: "ownerState" } },
  { key: "ownerPinCode",       label: "Pin Code",                group: "address", store: { kind: "snapshotOwnership", snapshotKey: "ownerPinCode" } },
  { key: "bankName",           label: "Bank Name",               group: "bank", store: { kind: "column", column: "bank_name" } },
  { key: "accountNumber",      label: "Account Number",          group: "bank", store: { kind: "column", column: "account_number" } },
  { key: "beneficiaryName",    label: "Beneficiary Name",        group: "bank", store: { kind: "column", column: "beneficiary_name" } },
  { key: "ifscCode",           label: "IFSC Code",               group: "bank", store: { kind: "column", column: "ifsc_code" } },
  { key: "bankBranch",         label: "Bank Branch",             group: "bank", store: { kind: "snapshotOwnership", snapshotKey: "branch" } },
  { key: "accountType",        label: "Account Type",            group: "bank", hint: "Savings or Current", store: { kind: "snapshotOwnership", snapshotKey: "accountType" } },
  { key: "salesManagerName",   label: "Sales Manager Name",      group: "sales_manager", store: { kind: "column", column: "sales_manager_name" } },
  { key: "salesManagerEmail",  label: "Sales Manager Email",     group: "sales_manager", store: { kind: "column", column: "sales_manager_email" } },
  { key: "salesManagerMobile", label: "Sales Manager Mobile",    group: "sales_manager", store: { kind: "column", column: "sales_manager_mobile" } },
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

const FIELD_BY_KEY = new Map<CorrectionFieldKey, CorrectionField>(
  CORRECTION_FIELDS.map((f) => [f.key, f]),
);

// Where a field's value is stored. request-correction (snapshot the previous
// value) and apply-correction (write the dealer's new value) route by this.
export function fieldStore(key: string): CorrectionFieldStore | null {
  return FIELD_BY_KEY.get(key as CorrectionFieldKey)?.store ?? null;
}

// CamelCase catalog key → snake_case dealer_onboarding_applications column, for
// the column-backed fields only. Derived from the catalog so it can never drift.
// Fields that live in JSON (companyAddress, owner address, bank branch, account
// type) are NOT here — route them via fieldStore() instead.
export const FIELD_KEY_TO_COLUMN: Partial<Record<CorrectionFieldKey, string>> =
  Object.fromEntries(
    CORRECTION_FIELDS.filter((f) => f.store.kind === "column").map((f) => [
      f.key,
      (f.store as { kind: "column"; column: string }).column,
    ]),
  );

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
