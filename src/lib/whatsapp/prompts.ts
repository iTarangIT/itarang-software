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
      account_type: "account type — 'savings' or 'current' — if shown",
      address_line1: "the account holder's street/house address line, if shown",
      city: "the account holder's city, if shown",
      district: "the account holder's district, if shown",
      state: "the account holder's state, if shown",
      pincode: "the 6-digit PIN code of the account holder's address, if shown",
    },
  },
  cancelled_cheque: {
    description: "Indian bank cancelled cheque leaf",
    fields: {
      bank_name: "name of the bank",
      account_number: "the account number",
      ifsc: "the IFSC code",
      account_holder_name: "the account holder's name printed on the cheque",
      branch: "branch name or branch address printed on the cheque, if shown",
      account_type: "account type — 'savings' or 'current' — if shown",
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
