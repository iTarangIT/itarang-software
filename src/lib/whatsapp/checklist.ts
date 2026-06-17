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
  // A sole proprietor's personal Income Tax Returns are the business income
  // proof, so a sole proprietorship needs 7 documents (6 common + ITR).
  sole_proprietorship: [
    {
      type: "itr",
      label: "Income Tax Returns (last 3 years)",
      request:
        "Please send your *last 3 years' Income Tax Returns (ITR)* (a single PDF is fine).",
    },
  ],
  // A partnership firm needs the sole-proprietor set of 7 (incl. ITR) plus two
  // partnership-specific documents — the Partnership Deed and partner photos —
  // for a total of 9.
  partnership_firm: [
    {
      type: "itr",
      label: "Income Tax Returns (last 3 years)",
      request:
        "Please send your *last 3 years' Income Tax Returns (ITR)* (a single PDF is fine).",
    },
    {
      type: "partnership_deed",
      label: "Partnership Deed",
      request: "Please send a *copy of your Partnership Deed*.",
    },
    {
      type: "partner_photo",
      label: "Partner Photograph",
      request: "Please send a *passport-size photograph of the partner(s)*.",
    },
  ],
  // Private limited: 6 common + MoA + AoA + partner photo + partnership deed = 10.
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
    {
      type: "partner_photo",
      label: "Partner Photograph",
      request: "Please send a *passport-size photograph of the partner(s)/director(s)*.",
    },
    {
      type: "partnership_deed",
      label: "Partnership Deed",
      request: "Please send a *copy of your Partnership Deed*.",
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

// Friendly label for ANY known document type, regardless of company type — used
// to tell a dealer what a wrong/non-required upload looks like.
const ALL_DOC_LABELS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const d of COMMON_DOCS) map[d.type] = d.label;
  for (const arr of Object.values(EXTRA_DOCS)) {
    for (const d of arr) map[d.type] = d.label;
  }
  // ITR appears only in entity-specific lists above; ensure it's covered.
  map.itr = map.itr || "Income Tax Returns";
  return map;
})();

export function docTypeLabel(type: string): string {
  return ALL_DOC_LABELS[type] ?? type.toUpperCase().replace(/_/g, " ");
}

// A human-readable checklist of every document the given company type needs,
// sent right after the dealer picks their type so they know the full list up
// front. The upload method (one-by-one vs ZIP folder) is chosen separately via
// tappable buttons, so this message is just the list.
export function documentChecklistMessage(
  companyType: CompanyType | null | undefined,
): string {
  const lines = requiredDocuments(companyType).map((d, i) => `${i + 1}. ${d.label}`);
  return [
    "📋 Here are the documents I'll need for your onboarding:",
    "",
    ...lines,
  ].join("\n");
}

// Critical fields that MUST be present (non-blank) for each document to count as
// usable. If Gemini returns these blank, the bot tells the dealer exactly what
// it couldn't read and asks for a clearer copy (instead of silently accepting an
// unreadable upload). Keyed by document type, independent of company type.
export const KEY_FIELDS: Record<string, string[]> = {
  gst: ["gstin"],
  company_pan: ["pan"],
  bank_statement: ["account_number", "ifsc"],
  cancelled_cheque: ["account_number", "ifsc"],
  udyam: ["udyam_number"],
  owner_photo: ["face_present"],
  partner_photo: ["face_present"],
  partnership_deed: ["partner_names"],
  mou: ["entity_name"],
  aoa: ["entity_name"],
};

// Dealer-facing names for the extracted field keys, used in "couldn't read the
// X" messages.
const FIELD_LABELS: Record<string, string> = {
  gstin: "GST number",
  pan: "PAN number",
  account_number: "account number",
  ifsc: "IFSC code",
  udyam_number: "Udyam number",
  face_present: "a clear face",
  partner_names: "partner names",
  entity_name: "company name",
  firm_name: "firm name",
};

export function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key.replace(/_/g, " ");
}

// A field value counts as "blank" when it's null/undefined, an empty/whitespace
// string, an empty array, or boolean false (e.g. face_present=false for a photo
// with no detectable face).
export function isBlankValue(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "boolean") return v === false;
  return false;
}

// Which of a document type's key fields came back blank from extraction.
export function blankKeyFields(
  docType: string,
  fields: Record<string, unknown> | null | undefined,
): string[] {
  return (KEY_FIELDS[docType] ?? []).filter((k) => isBlankValue(fields?.[k]));
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
  "Reply with one of: *Proprietor*, *Partnership*, or *Private Limited*.";
