// Assemble "what do we actually know about this person so far" for the admin
// WhatsApp-onboarding console.
//
// Three stores hold pieces of the answer and none of them is complete on its own:
//
//   1. `dealer_onboarding_applications` columns — what fillFromDoc() has already
//      flushed out of the documents (orchestrator.ts:2751).
//   2. `whatsapp_onboarding_sessions.context.answers` — what the dealer typed in
//      chat. ASK_FIELDS values land here first and only reach a column later.
//   3. `context.docs[type].fields` — everything Gemini read out of a document,
//      including fields that have no column at all (branch, account type, …).
//
// Precedence is column → chat answer → document, so a value an admin has already
// seen on the application page never gets shadowed by a rawer copy of itself.
//
// Pure and dependency-free — safe to import from a "use client" component.

import type { Ctx } from "./session-store";

export type CapturedSource = "application" | "chat_answer" | "document";

export interface CapturedField {
  key: string;
  label: string;
  value: string;
  source: CapturedSource;
  /** Set when source === 'document' — which upload the value came from. */
  docType?: string;
}

/** Application columns worth showing, in the order an admin reads them. */
const APPLICATION_FIELDS: Array<{
  key: string;
  label: string;
  column: string;
  /** Matching `Ctx.answers` key, when the dealer can also type this in chat. */
  answerKey?: string;
}> = [
  { key: "companyName", label: "Business name", column: "company_name" },
  { key: "companyType", label: "Business type", column: "company_type" },
  { key: "dealerType", label: "Dealer type", column: "dealer_type" },
  { key: "gstNumber", label: "GST number", column: "gst_number" },
  { key: "panNumber", label: "Company PAN", column: "pan_number" },
  { key: "cinNumber", label: "CIN", column: "cin_number" },
  { key: "ownerName", label: "Owner name", column: "owner_name", answerKey: "ownerName" },
  { key: "ownerPhone", label: "Owner mobile", column: "owner_phone", answerKey: "ownerPhone" },
  { key: "ownerEmail", label: "Owner email", column: "owner_email", answerKey: "ownerEmail" },
  { key: "ownerAadhaar", label: "Owner Aadhaar", column: "owner_aadhaar_no" },
  { key: "businessAddress", label: "Business address", column: "business_address" },
  { key: "city", label: "City", column: "city" },
  { key: "state", label: "State", column: "state" },
  { key: "pincode", label: "Pincode", column: "pincode" },
  { key: "bankName", label: "Bank", column: "bank_name" },
  { key: "accountNumber", label: "Account number", column: "account_number" },
  { key: "ifscCode", label: "IFSC", column: "ifsc_code" },
  { key: "beneficiaryName", label: "Account holder", column: "beneficiary_name" },
];

/** Document-extracted keys that have no application column of their own. */
const EXTRA_DOC_FIELD_LABELS: Record<string, string> = {
  trade_name: "Trade name",
  legal_name: "Legal name",
  branch: "Bank branch",
  account_type: "Account type",
  enterprise_name: "Enterprise name",
  udyam_number: "Udyam number",
  date_of_incorporation: "Date of incorporation",
  registration_date: "Registration date",
};

const HUMAN_KEY = /_/g;

function humanizeKey(key: string): string {
  const known = EXTRA_DOC_FIELD_LABELS[key];
  if (known) return known;
  const spaced = key.replace(HUMAN_KEY, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Render any stored value as display text. `business_address` is written as a
 * JSON string by fillFromDoc, so unwrap it rather than showing raw JSON.
 */
function toDisplay(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const parts = [
          parsed.address,
          parsed.city,
          parsed.state,
          parsed.pincode,
        ]
          .filter((p): p is string => typeof p === "string" && p.trim() !== "")
          .join(", ");
        if (parts) return parts;
      } catch {
        // Not JSON after all — fall through and show it verbatim.
      }
    }
    return trimmed;
  }
  return "";
}

/**
 * Everything captured so far, ready to render. Empty values are dropped, so the
 * length of the result IS the "N details captured" progress number.
 */
export function buildCapturedDetails(
  application: Record<string, unknown> | null | undefined,
  ctx: Ctx | null | undefined,
): CapturedField[] {
  const app = application ?? {};
  const answers = (ctx?.answers ?? {}) as Record<string, unknown>;
  const docs = (ctx?.docs ?? {}) as Ctx["docs"];
  const out: CapturedField[] = [];
  const seen = new Set<string>();

  for (const spec of APPLICATION_FIELDS) {
    const fromColumn = toDisplay(app[spec.column]);
    if (fromColumn) {
      out.push({
        key: spec.key,
        label: spec.label,
        value: fromColumn,
        source: "application",
      });
      seen.add(spec.key);
      continue;
    }
    if (spec.answerKey) {
      const fromChat = toDisplay(answers[spec.answerKey]);
      if (fromChat) {
        out.push({
          key: spec.key,
          label: spec.label,
          value: fromChat,
          source: "chat_answer",
        });
        seen.add(spec.key);
      }
    }
  }

  // Anything else the dealer typed in chat that isn't already covered above.
  for (const [key, raw] of Object.entries(answers)) {
    if (seen.has(key)) continue;
    const value = toDisplay(raw);
    if (!value) continue;
    out.push({
      key,
      label: humanizeKey(key),
      value,
      source: "chat_answer",
    });
    seen.add(key);
  }

  // Finally, document-extracted values with no column and no chat answer — these
  // are the ones that would otherwise be invisible until the dealer submits.
  for (const [docType, entry] of Object.entries(docs ?? {})) {
    for (const [key, raw] of Object.entries(entry?.fields ?? {})) {
      const composite = `${docType}.${key}`;
      if (seen.has(key) || seen.has(composite)) continue;
      const value = toDisplay(raw);
      if (!value) continue;
      out.push({
        key: composite,
        label: humanizeKey(key),
        value,
        source: "document",
        docType,
      });
      seen.add(composite);
    }
  }

  return out;
}
