/**
 * The parts of a quotation that are about iTarang rather than about the deal:
 * the letterhead, the bank block, the signatory, the notes and the terms.
 *
 * WHY THIS IS CONFIG AND NOT A CONSTANT IN THE TEMPLATE
 *   Every value here is a business fact that changes without a deploy — a bank
 *   account, a registered address, who signs, a payment term. The brief asked
 *   for the format to be "maintainable/configurable rather than hardcoded
 *   wherever practical", and these are exactly the fields that qualify. The
 *   LAYOUT is code because it is a design; the CONTENT of the letterhead is
 *   data because it is a fact about the company.
 *
 * RESOLUTION ORDER — app_settings row > built-in default, per field.
 *   Same shape as src/lib/telemetry/thresholds.ts. The defaults are the values
 *   printed on docs/ITPI-35 (1).pdf, so an unconfigured database renders the
 *   document the business already signed off rather than a blank letterhead.
 *   A partial app_settings row overrides only the keys it names.
 *
 * The one field NOT defaulted is the seller state: it decides IGST vs
 * CGST+SGST, and a wrong default there produces a wrong tax document. It is
 * derived from the GSTIN's first two digits, which is the authoritative source
 * for it, and falls back to Haryana only because that is where the registered
 * office in the default block is.
 *
 * PURE — no database import, deliberately. The app_settings read lives in
 * ./config-store, the same split thresholds-math.ts / thresholds.ts uses, so
 * the defaults and the merge can be unit-tested without a DATABASE_URL.
 */
import type { BankBlock, SellerBlock } from "./types";

export const QUOTATION_SETTINGS_KEY = "quotation_document";

export interface QuotationDocConfig {
  documentTitle: string;
  seller: SellerBlock;
  bank: BankBlock;
  signatory: string | null;
  notes: string[];
  terms: string[];
  /** Prefix of the quotation number series, e.g. "ITQ". */
  numberPrefix: string;
}

/**
 * Straight off docs/ITPI-35 (1).pdf. Changing these changes what every
 * unconfigured environment prints, so they are the document of record until an
 * app_settings row says otherwise.
 */
export const DEFAULT_QUOTATION_CONFIG: QuotationDocConfig = {
  documentTitle: "Proforma Invoice",
  seller: {
    legalName: "ITARANG TECHNOLOGIES LLP",
    addressLines: [
      "First Floor, Unit no. 103, Unitech Business Zone, Block B",
      "Nirvana Country, South City - 2, Sector 50",
      "Gurugram Haryana 122018",
      "India",
    ],
    gstin: "06AALFI7813E1ZE",
    email: "care.itarang@gmail.com",
    website: "www.itarang.com",
    // 06 is Haryana — and is also the first two digits of the GSTIN above,
    // which is where resolveQuotationConfig() re-derives it from.
    stateCode: "06",
    stateName: "Haryana",
  },
  bank: {
    bank: "IDFC First Bank",
    accountName: "ITARANG TECHNOLOGIES LLP",
    accountNo: "63010202532",
    ifsc: "IDFB0022462",
    branch: "GURGAON SECTOR 58",
  },
  signatory: "Chirag Garg",
  notes: ["Looking forward for your business."],
  terms: [
    "This is a Proforma Invoice. Goods will be dispatched upon receipt of 100% payment / purchase order.",
    "Payment due within 30 days.",
    "Goods once sold will not be taken back.",
    "Interest @24% p.a. will be charged if payment is delayed beyond due date.",
    "Delivery charges: As per actual.",
    "Subject to Gurugram jurisdiction.",
  ],
  numberPrefix: "ITQ",
};

/**
 * The first two digits of a GSTIN are the state code of the registration.
 *
 * Deriving the seller state from the GSTIN rather than storing it separately
 * removes the failure where somebody updates the GSTIN, forgets the state code,
 * and every quotation silently switches between IGST and CGST+SGST.
 */
export function stateCodeFromGstin(gstin: string | null | undefined): string | null {
  if (!gstin) return null;
  const head = gstin.trim().slice(0, 2);
  return /^\d{2}$/.test(head) ? head : null;
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length === v.length ? out : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * Merge a stored patch over the defaults, field by field.
 *
 * Deliberately tolerant: a malformed or partial app_settings value degrades to
 * the default for that field instead of throwing. This runs inside quotation
 * generation, which runs after an approval has already committed — a bad config
 * row must not be able to turn a released quote into a document that cannot be
 * produced at all.
 */
export function mergeQuotationConfig(
  patch: unknown,
  base: QuotationDocConfig = DEFAULT_QUOTATION_CONFIG,
): QuotationDocConfig {
  if (!patch || typeof patch !== "object") return base;
  const p = patch as Record<string, unknown>;

  const sellerPatch = (p.seller ?? {}) as Record<string, unknown>;
  const bankPatch = (p.bank ?? {}) as Record<string, unknown>;

  const gstin = asString(sellerPatch.gstin) ?? base.seller.gstin;

  const seller: SellerBlock = {
    legalName: asString(sellerPatch.legalName) ?? base.seller.legalName,
    addressLines:
      asStringArray(sellerPatch.addressLines) ?? base.seller.addressLines,
    gstin,
    email: asString(sellerPatch.email) ?? base.seller.email,
    website: asString(sellerPatch.website) ?? base.seller.website,
    // An explicit stateCode wins; otherwise re-derive from whatever GSTIN is in
    // force after the merge, so the two can never disagree.
    stateCode:
      asString(sellerPatch.stateCode) ??
      stateCodeFromGstin(gstin) ??
      base.seller.stateCode,
    stateName: asString(sellerPatch.stateName) ?? base.seller.stateName,
  };

  return {
    documentTitle: asString(p.documentTitle) ?? base.documentTitle,
    seller,
    bank: {
      bank: asString(bankPatch.bank) ?? base.bank.bank,
      accountName: asString(bankPatch.accountName) ?? base.bank.accountName,
      accountNo: asString(bankPatch.accountNo) ?? base.bank.accountNo,
      ifsc: asString(bankPatch.ifsc) ?? base.bank.ifsc,
      branch: asString(bankPatch.branch) ?? base.bank.branch,
    },
    signatory: asString(p.signatory) ?? base.signatory,
    notes: asStringArray(p.notes) ?? base.notes,
    terms: asStringArray(p.terms) ?? base.terms,
    numberPrefix: asString(p.numberPrefix) ?? base.numberPrefix,
  };
}
