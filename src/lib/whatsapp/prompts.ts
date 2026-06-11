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
      address: "principal place of business address",
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
    },
  },
  cancelled_cheque: {
    description: "Indian bank cancelled cheque leaf",
    fields: {
      bank_name: "name of the bank",
      account_number: "the account number",
      ifsc: "the IFSC code",
      account_holder_name: "the account holder's name printed on the cheque",
    },
  },
  udyam: {
    description: "Indian Udyam (MSME) registration certificate",
    fields: {
      udyam_number: "the Udyam registration number (UDYAM-XX-00-0000000)",
      enterprise_name: "name of the enterprise",
    },
  },
  owner_photo: {
    description: "a passport-size photograph of a person",
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
