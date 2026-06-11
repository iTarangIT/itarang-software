// Required documents + fields per dealer/company type (design §11).
//
// The orchestrator walks `requiredDocuments(companyType)` in order, asking for
// one document at a time, then asks any `ASK_FIELDS` not derivable from docs.
// Phase 1 covers the common documents + the legal docs that distinguish each
// company type. ITR is accepted as a single upload for now.

export type CompanyType =
  | "sole_proprietorship"
  | "partnership_firm"
  | "private_limited_firm"
  | "llp";

/** verifiable = which Decentro check (if any) applies to this doc's fields. */
export interface DocSpec {
  type: string;
  label: string;
  /** Short instruction sent to the dealer when requesting this document. */
  request: string;
  verifiable?: "gst" | "pan" | "bank" | null;
}

// Documents every currently-implemented dealer type must provide.
const COMMON_DOCS: DocSpec[] = [
  {
    type: "gst",
    label: "GST Certificate",
    request: "Please send your *GST Certificate* (photo or PDF).",
    verifiable: "gst",
  },
  {
    type: "company_pan",
    label: "Company PAN",
    request: "Please send your *Company PAN card*.",
    verifiable: "pan",
  },
  {
    type: "bank_statement",
    label: "Bank Statement (last 3 months)",
    request: "Please send your *last 3 months' company bank statement*.",
    verifiable: "bank",
  },
  {
    type: "cancelled_cheque",
    label: "Cancelled Cheque",
    request: "Please send a *cancelled cheque* of your company account.",
    verifiable: "bank",
  },
  {
    type: "udyam",
    label: "Udyam Registration",
    request: "Please send your *Udyam Registration Certificate*.",
  },
  {
    type: "owner_photo",
    label: "Owner Photograph",
    request: "Please send a *passport-size photograph* of the owner.",
  },
];

// Legal documents specific to the entity type.
const EXTRA_DOCS: Record<CompanyType, DocSpec[]> = {
  sole_proprietorship: [],
  partnership_firm: [
    {
      type: "partnership_deed",
      label: "Partnership Deed",
      request: "Please send your *Partnership Deed*.",
    },
  ],
  private_limited_firm: [
    {
      type: "mou",
      label: "Memorandum of Association (MoA)",
      request: "Please send your *Memorandum of Association (MoA)*.",
    },
    {
      type: "aoa",
      label: "Articles of Association (AoA)",
      request: "Please send your *Articles of Association (AoA)*.",
    },
  ],
  // LLP maps to the partnership-style flow until it's a first-class wizard type
  // (design §11).
  llp: [
    {
      type: "partnership_deed",
      label: "LLP Agreement",
      request: "Please send your *LLP Agreement*.",
    },
  ],
};

export function requiredDocuments(
  companyType: CompanyType | null | undefined,
): DocSpec[] {
  const ct = companyType ?? "sole_proprietorship";
  return [...COMMON_DOCS, ...(EXTRA_DOCS[ct] ?? [])];
}

export function docSpec(
  companyType: CompanyType | null | undefined,
  type: string,
): DocSpec | undefined {
  return requiredDocuments(companyType).find((d) => d.type === type);
}

// Fields the bot asks directly (not reliably present in documents, design §5/§11).
// Asked in order after all documents are collected.
export interface FieldSpec {
  key: string;
  question: string;
  kind: "text" | "phone" | "email" | "yesno";
}

export const ASK_FIELDS: FieldSpec[] = [
  { key: "ownerName", question: "What is the *owner's full name*?", kind: "text" },
  { key: "ownerPhone", question: "What is the *owner's mobile number*?", kind: "phone" },
  { key: "ownerEmail", question: "What is the *owner's email address*?", kind: "email" },
  {
    key: "financeEnabled",
    question: "Do you want *financing enabled* for your customers? (yes/no)",
    kind: "yesno",
  },
];

// Map a dealer's free-text company-type answer to a canonical CompanyType.
export function parseCompanyType(input: string): CompanyType | null {
  const t = (input || "").toLowerCase();
  if (/(sole|proprietor|individual)/.test(t)) return "sole_proprietorship";
  if (/(partner)/.test(t)) return "partnership_firm";
  if (/(llp)/.test(t)) return "llp";
  if (/(pvt|private|ltd|limited|company)/.test(t)) return "private_limited_firm";
  return null;
}

export const COMPANY_TYPE_PROMPT =
  "What is your *company type*?\n" +
  "Reply with one of: *Proprietor*, *Partnership*, *Private Limited*, or *LLP*.";
