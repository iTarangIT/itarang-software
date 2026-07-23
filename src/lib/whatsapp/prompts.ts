// Per-document-type extraction prompts for Gemini 3.1 Flash-Lite.
//
// Each prompt asks for a STRICT JSON object with a fixed shape so the result is
// parseable at temperature 0. The expected field set per doc type is listed so
// the model knows exactly what to return (and returns null for anything it
// cannot read, rather than hallucinating).

interface DocFieldSpec {
  /** Human description of the document, used in the prompt. */
  description: string;
  /** The fields to extract, with a short hint each. */
  fields: Record<string, string>;
}

const DOC_FIELDS: Record<string, DocFieldSpec> = {
  gst: {
    description: "Indian GST registration certificate",
    fields: {
      gstin: "the 15-character GSTIN",
      legal_name: "legal name of the business",
      trade_name: "trade name, if shown",
      address: "principal place of business address (full line)",
      address_line1: "building/street part of the principal place of business, if shown",
      city: "city of the principal place of business, if shown",
      district: "district of the principal place of business, if shown",
      state: "state of the principal place of business, if shown",
      pincode: "the 6-digit PIN code of the principal place of business, if shown",
      additional_places_count:
        "the integer 'Total Number of Additional Places of Business in the State', or 0 if none shown",
      additional_places:
        'an ARRAY of the Additional Place(s) of Business in the State (these are often listed on a separate annexure page after the principal place). For EACH additional place return an object {"address_line1": <building/street>, "city": <city>, "district": <district>, "state": <state>, "pincode": <6-digit PIN>, "full_address": <full address line>}. Return [] if there are no additional places',
    },
  },
  company_pan: {
    description: "Indian PAN card (company or individual)",
    fields: {
      pan: "the 10-character PAN",
      name: "name printed on the card",
    },
  },
  bank_statement: {
    description: "Indian bank account statement",
    fields: {
      bank_name: "name of the bank",
      account_number: "the account number",
      ifsc: "the IFSC code",
      account_holder_name: "the account holder's name",
      branch: "branch name, if shown",
      account_type:
        "the account type, normalised to exactly 'savings' or 'current'. Look for an explicit label (e.g. 'Account Type', 'A/C Type', 'Scheme') AND for common indicators: 'SB'/'SBA'/'Savings Bank' → 'savings'; 'CA'/'CD'/'Current Account'/'OD'/'Overdraft' → 'current'. Return the normalised word only, or omit if genuinely not determinable.",
      address_line1: "the account holder's street/house address line, if shown",
      city: "the account holder's city, if shown",
      district: "the account holder's district, if shown",
      state: "the account holder's state, if shown",
      pincode: "the 6-digit PIN code of the account holder's address, if shown",
    },
  },
  cancelled_cheque: {
    description:
      "an Indian bank cancelled cheque leaf OR a bank passbook page (either one shows the account number & IFSC)",
    fields: {
      bank_name: "name of the bank",
      account_number: "the account number",
      ifsc: "the IFSC code",
      account_holder_name: "the account holder's name printed on the cheque or passbook",
      branch: "branch name or branch address printed on the cheque or passbook, if shown",
      account_type:
        "the account type, normalised to exactly 'savings' or 'current'. Look for an explicit label AND for common indicators: 'SB'/'SBA'/'Savings Bank' → 'savings'; 'CA'/'CD'/'Current Account'/'OD'/'Overdraft' → 'current'. Return the normalised word only, or omit if genuinely not determinable.",
    },
  },
  udyam: {
    description: "Indian Udyam (MSME) registration certificate",
    fields: {
      udyam_number: "the Udyam registration number (UDYAM-XX-00-0000000)",
      enterprise_name: "name of the enterprise",
      owner_name: "name of the owner / entrepreneur / proprietor, if shown",
      owner_mobile: "the registered mobile number, if shown",
      owner_email: "the registered email address, if shown",
      address_line1: "flat/door/building/street of the official enterprise address, if shown",
      city: "city/town of the official enterprise address, if shown",
      district: "district of the official enterprise address, if shown",
      state: "state of the official enterprise address, if shown",
      pincode: "the 6-digit PIN code of the official enterprise address, if shown",
    },
  },
  owner_photo: {
    description: "a passport-size photograph of a person",
    fields: {
      face_present: "true if a clear human face is visible, else false",
    },
  },
  partner_photo: {
    description: "a passport-size photograph of a business partner",
    fields: {
      face_present: "true if a clear human face is visible, else false",
    },
  },
  itr: {
    description: "Indian Income Tax Return (ITR) acknowledgement",
    fields: {
      pan: "the PAN on the return",
      assessment_year: "the assessment year",
      gross_total_income: "gross total income amount, if shown",
    },
  },
  partnership_deed: {
    description: "a partnership deed or LLP agreement (legal document)",
    fields: {
      firm_name: "name of the firm",
      partner_names: "array of partner names mentioned",
    },
  },
  mou: {
    description: "a Memorandum of Association (MoA)",
    fields: { entity_name: "name of the company/entity" },
  },
  aoa: {
    description: "Articles of Association (AoA)",
    fields: { entity_name: "name of the company/entity" },
  },

  // ── Dealer onboarding: owner Aadhaar (E-175) ────────────────────────────────
  // Captured so the owner's Aadhaar number can be matched against the Aadhaar
  // used to sign the onboarding agreement (Digio Aadhaar eSign).
  owner_aadhaar: {
    description:
      "an Indian Aadhaar card belonging to the business OWNER (the side showing the 12-digit Aadhaar number)",
    fields: {
      aadhaar_number: "the 12-digit Aadhaar number (digits only)",
      name: "the cardholder's full name",
      dob: "date of birth as printed (DD/MM/YYYY or YYYY), if shown",
    },
  },

  // ── Customer KYC documents (WhatsApp dealer-console "New Lead" flow) ─────────
  aadhaar_front: {
    description: "the FRONT of an Indian Aadhaar card (photo side with name & DOB)",
    fields: {
      aadhaar_number: "the 12-digit Aadhaar number (digits only)",
      name: "the cardholder's full name",
      dob: "date of birth as printed (DD/MM/YYYY or YYYY)",
      gender: "gender — 'male', 'female' or 'other' — if shown",
    },
  },
  aadhaar_back: {
    description: "the BACK of an Indian Aadhaar card (address side)",
    fields: {
      aadhaar_number: "the 12-digit Aadhaar number, if shown (digits only)",
      address_line1: "house/street part of the address",
      city: "city/town/village, if shown",
      district: "district, if shown",
      state: "state, if shown",
      pincode: "the 6-digit PIN code, if shown",
      full_address: "the full address as printed",
    },
  },
  pan_card: {
    description: "an Indian individual PAN card",
    fields: {
      pan: "the 10-character PAN (no spaces)",
      name: "the name printed on the card",
      father_name: "the father's name, if shown",
      dob: "date of birth as printed (DD/MM/YYYY)",
    },
  },
  customer_photo: {
    description: "a passport-size photograph of the customer",
    fields: {
      face_present: "true if a clear human face is visible, else false",
    },
  },
  address_proof: {
    description:
      "an Indian address proof document (Aadhaar, utility bill, voter ID, passport, or any document showing a residential address)",
    fields: {
      name: "the person's name, if shown",
      address_line1: "house/street part of the residential address",
      city: "city/town, if shown",
      district: "district, if shown",
      state: "state, if shown",
      pincode: "the 6-digit PIN code, if shown",
      full_address: "the full residential address as printed",
    },
  },
  rc_copy: {
    description:
      "an Indian vehicle Registration Certificate (RC / RC smart card / RC book)",
    fields: {
      registration_number: "the vehicle registration number (e.g. MH12AB1234)",
      owner_name: "the registered owner's name, if shown",
      vehicle_class: "the vehicle class / type, if shown",
      maker_model: "the maker's name and model, if shown",
      chassis_number: "the chassis number, if shown",
      engine_number: "the engine number, if shown",
    },
  },
};

export function fieldKeysFor(docType: string): string[] {
  return Object.keys(DOC_FIELDS[docType]?.fields ?? {});
}

/** The document types the classifier may assign to an unlabelled file. */
export const CLASSIFIABLE_DOC_TYPES = Object.keys(DOC_FIELDS);

// Prompt for a ZIP / batch upload where the file is NOT pre-labelled: the model
// first decides WHICH document type the file is, then extracts that type's
// fields. Used by classifyDocument() so a dealer can dump every document at once
// and the bot sorts them out (design: batch upload). The full field catalogue is
// embedded so the model returns field names that match the per-type extraction
// (fillFromDoc keys off document_type + those field names).
export function buildClassifyPrompt(): string {
  const typeLines = Object.entries(DOC_FIELDS)
    .map(([type, spec]) => `  - "${type}": ${spec.description}`)
    .join("\n");

  const fieldCatalog = Object.entries(DOC_FIELDS)
    .map(([type, spec]) => {
      const fields = Object.entries(spec.fields)
        .map(([k, hint]) => `      "${k}": <${hint}, or null>`)
        .join(",\n");
      return `  if document_type is "${type}":\n    "fields": {\n${fields}\n    }`;
    })
    .join("\n");

  return [
    "You are reading ONE Indian business document uploaded by a motor-vehicle dealer as part of a batch upload.",
    "The file is UNLABELLED — first decide which document type it is, then extract that type's fields.",
    "",
    "Possible document types:",
    typeLines,
    "",
    "Return ONLY a JSON object with EXACTLY this shape (no markdown, no commentary):",
    "{",
    '  "document_type": <one of the keys above, or "unknown" if it is none of them>,',
    '  "legible": <true if clear enough to read, false if blurry/cropped/dark>,',
    '  "confidence": <number 0 to 1 — your confidence in the type AND the extracted fields>,',
    '  "fields": { <the fields for the detected document_type, per the catalogue below> }',
    "}",
    "",
    "Field catalogue (return the field set matching the document_type you chose):",
    fieldCatalog,
    "",
    "Rules:",
    "- Read values EXACTLY as printed; do not guess or correct them.",
    "- If a field is not present or not readable, return null for it.",
    '- If the file is not a recognisable business document, set document_type="unknown", fields={}.',
    "- Remove spaces from GSTIN / PAN / IFSC / account numbers.",
  ].join("\n");
}

export function buildExtractionPrompt(docType: string): string {
  const spec = DOC_FIELDS[docType] ?? {
    description: "an Indian business document",
    fields: { text: "any key identifying values" },
  };

  const fieldLines = Object.entries(spec.fields)
    .map(([k, hint]) => `    "${k}": <${hint}, or null if not readable>`)
    .join(",\n");

  return [
    `You are reading ${spec.description} uploaded by an Indian motor-vehicle dealer.`,
    `The document is EXPECTED to be: ${spec.description}.`,
    "",
    "Return ONLY a JSON object with EXACTLY this shape (no markdown, no commentary):",
    "{",
    `  "is_expected_type": <true if the image/PDF really is ${spec.description}, else false>,`,
    `  "legible": <true if the document is clear enough to read, false if blurry/cropped/dark>,`,
    `  "confidence": <number 0 to 1 — your confidence in the extracted fields>,`,
    `  "fields": {`,
    fieldLines,
    "  }",
    "}",
    "",
    "Rules:",
    "- Read values EXACTLY as printed; do not guess or correct them.",
    "- If a field is not present or not readable, return null for it.",
    "- If the document is not the expected type, set is_expected_type=false and still extract any fields you can.",
    "- Remove spaces from GSTIN / PAN / IFSC / account numbers.",
  ].join("\n");
}

// ── Entry-router intent classification (WhatsApp free-text front door) ───────
// The greeting no longer shows tappable buttons; instead the user types what
// they need (English or Hindi/Hinglish) and this classifier routes them into
// one of the flows — or flags the message as too hard, in which case the caller
// tells them the team will follow up and asks whether they're a customer or a
// dealer.
export type IntentId =
  | "dealer_onboarding"
  | "customer_onboarding"
  | "general_info"
  | "too_hard";

export const INTENT_IDS: readonly IntentId[] = [
  "dealer_onboarding",
  "customer_onboarding",
  "general_info",
  "too_hard",
];

// Each category with a short description used both in the prompt and as the
// canonical routing key. Kept factual and bilingual-friendly since inbound
// messages may be English or Hindi (Devanagari or romanized).
const INTENT_CATEGORIES: Record<Exclude<IntentId, "too_hard">, string> = {
  dealer_onboarding:
    "the sender is a business owner / shopkeeper who wants to BECOME an iTarang dealer or partner (e.g. 'I want to become a dealer', 'mujhe dealer banna hai', 'dealership chahiye', 'apni shop register karni hai')",
  customer_onboarding:
    "the sender is an end CUSTOMER interested in buying an EV battery / product or getting financing/EMI for one, or wants to register their enquiry AS A CUSTOMER (e.g. 'I want to buy a battery', 'battery chahiye', 'loan chahiye', 'EMI par lena hai', 'main customer hoon')",
  general_info:
    "the sender is asking a general question ABOUT iTarang or its products — what it is, how onboarding works, battery information, prices, whether financing is available, support — without clearly identifying as a dealer or a customer (e.g. 'what is iTarang', 'battery price kya hai', 'ye kaise kaam karta hai')",
};

// Router prompt: classify ONE free-text WhatsApp message into exactly one
// intent. Mirrors buildClassifyPrompt()'s strict-JSON contract. "too_hard" is
// the safety valve for anything the flows can't serve directly (complaints,
// order status, off-topic, gibberish) — the caller then replies "our team will
// get in touch" and asks whether they're a customer or a dealer.
export function buildIntentPrompt(): string {
  const categoryLines = Object.entries(INTENT_CATEGORIES)
    .map(([id, desc]) => `  - "${id}": ${desc}`)
    .join("\n");

  return [
    "You are the router for iTarang's WhatsApp assistant. iTarang is an Indian EV-battery company with a dealer network and customer financing.",
    "You are reading ONE message a person just sent. It may be in English or Hindi (Devanagari or romanized/Hinglish).",
    "Decide which ONE of these the person wants:",
    categoryLines,
    '  - "too_hard": none of the above — e.g. a complaint, order/delivery status, an off-topic or unclear/gibberish message, or anything a simple router should hand to a human.',
    "",
    "Return ONLY a JSON object with EXACTLY this shape (no markdown, no commentary):",
    "{",
    '  "intent": <one of: "dealer_onboarding", "customer_onboarding", "general_info", "too_hard">,',
    '  "confidence": <number 0 to 1 — how sure you are>',
    "}",
    "",
    "Rules:",
    "- Judge INTENT, not language. Understand Hindi and Hinglish.",
    '- Only choose "dealer_onboarding" or "customer_onboarding" when the sender clearly identifies as one. A generic product/price/info question is "general_info".',
    '- If it is a bare greeting with no request (just "hi"/"namaste"), return "too_hard" with low confidence.',
    "- Never invent facts; you are only classifying.",
  ].join("\n");
}

// Grounding prompt for the "General Information" entry-menu option — a small
// facts block the Q&A model must stay inside. Keep this SHORT and factual;
// anything not stated here the bot must decline to answer.
export const ITARANG_INFO_SYSTEM_PROMPT = [
  "You are the official WhatsApp assistant of iTarang.",
  "",
  "FACTS ABOUT ITARANG (the ONLY knowledge you may use):",
  "- iTarang is an Indian company in the electric-vehicle (EV) and battery ecosystem. It runs a dealer network for EV batteries and related products, and helps customers buy them with or without financing.",
  "- Dealer onboarding: business owners can become iTarang dealers directly on this WhatsApp number. The bot collects business documents (GST certificate, PAN, bank proof / cancelled cheque, and entity documents such as a Partnership Deed or MoA/AoA depending on company type), asks whether the dealer wants customer financing enabled, gets the dealer agreement e-signed, and sends the application to the iTarang team for approval.",
  "- Customer onboarding: customers interested in a battery/EV product can register on this WhatsApp number as a new enquiry (lead). The bot records their mobile number, interest level, payment preference (cash or financing) and product interest; for financed purchases it collects KYC documents (Aadhaar / PAN) with the customer's consent. The iTarang team then follows up.",
  "- Financing: iTarang works with NBFC partners to offer battery/EV loans with EMI plans; availability depends on the customer's documents and the partner's checks. Exact rates, EMIs and eligibility are confirmed by the team — never quote numbers.",
  "- Support: for anything this chat can't resolve, users can email support@itarang.com.",
  "",
  "RULES:",
  "- Answer ONLY from the facts above. If asked something outside them (prices, rates, stock, locations, order status, other companies, general knowledge), reply that you don't have that information and that the iTarang team can help (support@itarang.com).",
  "- Never invent pricing, interest rates, EMI amounts, dates or availability.",
  "- Keep every answer under 700 characters, in simple language. Use WhatsApp formatting: *bold* for emphasis, hyphen bullets. No markdown headings, no links other than the support email.",
  "- The user can type *menu* anytime to return to the main options — mention this when it helps.",
].join("\n");
