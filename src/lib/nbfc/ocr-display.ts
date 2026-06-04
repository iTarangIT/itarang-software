/**
 * Turn a `kyc_documents.ocr_data` blob into a small list of labelled fields for
 * read-only display on the NBFC dossier. Mirrors the field/nesting handling of
 * the admin OCR route (src/app/api/admin/kyc/[leadId]/ocr/route.ts) — Decentro
 * wraps payloads under kycResult / extractedData / result / ocrResult / data,
 * while the Tesseract fallback stores flat keys (account_number, pan_number…).
 *
 * Pure & dependency-free so both the server dossier panel and the client
 * verification-details component can import it.
 */

export interface OcrField {
  label: string;
  value: string;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

// Walk the common Decentro nesting levels (two deep) so a field buried under
// e.g. data.kycResult.extractedData is still discoverable.
function collectTargets(root: Record<string, unknown>): Record<string, unknown>[] {
  const NEST = ["kycResult", "extractedData", "result", "ocrResult", "data", "ocr_data"];
  const targets: Record<string, unknown>[] = [root];
  for (const k of NEST) {
    const o = asObj(root[k]);
    if (o) targets.push(o);
  }
  for (const t of [...targets]) {
    for (const k of NEST) {
      const o = asObj(t[k]);
      if (o && !targets.includes(o)) targets.push(o);
    }
  }
  return targets;
}

function pick(targets: Record<string, unknown>[], keys: string[]): string | undefined {
  for (const t of targets) {
    for (const key of keys) {
      const v = t[key];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number" && Number.isFinite(v)) return String(v);
    }
  }
  return undefined;
}

function pickAddress(targets: Record<string, unknown>[]): string | undefined {
  for (const t of targets) {
    for (const key of [
      "address",
      "full_address",
      "fullAddress",
      "currentAddress",
      "current_address",
      "localAddress",
      "addressLine",
    ]) {
      const v = t[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    for (const key of ["address", "addressObject", "address_object", "addressData"]) {
      const o = asObj(t[key]);
      if (o) {
        const parts = [
          o.line1 || o.addressLine1 || o.address_line_1,
          o.line2 || o.addressLine2 || o.address_line_2,
          o.street,
          o.locality || o.landmark,
          o.vtc || o.village || o.town || o.city,
          o.district,
          o.state,
          o.pincode || o.pin || o.postalCode || o.zip,
        ]
          .filter((p) => typeof p === "string" && (p as string).trim())
          .map((p) => (p as string).trim());
        if (parts.length > 0) return parts.join(", ");
      }
    }
  }
  return undefined;
}

const FIELD_SPECS: Record<string, { label: string; keys: string[] }[]> = {
  pan: [
    { label: "PAN", keys: ["pan_number", "panNumber", "id_number", "idNumber", "pan", "panNo"] },
    { label: "Name", keys: ["name", "nameOnDocument", "name_on_document", "fullName", "full_name"] },
    { label: "Father", keys: ["fatherName", "father_name", "fatherOrHusbandName"] },
    { label: "Date of birth", keys: ["dob", "dateOfBirth", "date_of_birth", "DOB"] },
  ],
  aadhaar: [
    { label: "Aadhaar", keys: ["idNumber", "id_number", "aadhaar_number", "aadhaarNumber", "uid", "aadhaarNo", "aadhaar_no", "maskedAadhaar", "masked_aadhaar"] },
    { label: "Name", keys: ["nameOnDocument", "name_on_document", "name", "fullName", "full_name", "holderName"] },
    { label: "Date of birth", keys: ["dob", "dateOfBirth", "date_of_birth", "DOB"] },
    { label: "Gender", keys: ["gender", "sex"] },
    { label: "Care of", keys: ["careOf", "careof", "care_of", "co", "fatherName", "father_name", "guardianName"] },
    { label: "Pincode", keys: ["pincode", "pinCode", "pin_code", "pin", "postalCode", "zip"] },
  ],
  bank: [
    { label: "Account number", keys: ["account_number", "accountNumber"] },
    { label: "IFSC", keys: ["ifsc", "ifsc_code", "ifscCode"] },
    { label: "Bank", keys: ["bank_name", "bankName"] },
    { label: "Branch", keys: ["branch", "branchName"] },
  ],
  rc: [
    { label: "RC number", keys: ["rc_number", "rcNumber", "registration_number", "registrationNumber"] },
    { label: "Chassis", keys: ["chassis_number", "chassisNumber"] },
    { label: "Engine", keys: ["engine_number", "engineNumber"] },
  ],
};

/** Map a `doc_type` (pan_card, aadhaar_front, bank_statement, cheque_2, rc_copy…) to a spec family. */
export function ocrFamilyForDocType(docType: string | null | undefined): keyof typeof FIELD_SPECS | null {
  const t = (docType ?? "").toLowerCase();
  if (t.includes("pan")) return "pan";
  if (t.includes("aadhaar") || t.includes("aadhar")) return "aadhaar";
  if (t.includes("bank") || t.includes("cheque") || t.includes("passbook")) return "bank";
  if (t.includes("rc") || t.includes("vehicle")) return "rc";
  return null;
}

/**
 * Extract labelled OCR fields from a document's `ocr_data`. Returns [] when
 * there's nothing meaningful (e.g. a photo, or a Tesseract row with only
 * rawText). `family` can be passed directly or derived from a doc_type.
 */
export function extractOcrFields(
  ocrData: unknown,
  docTypeOrFamily: string | null | undefined,
): OcrField[] {
  const root = asObj(ocrData);
  if (!root) return [];
  const family =
    docTypeOrFamily && docTypeOrFamily in FIELD_SPECS
      ? (docTypeOrFamily as keyof typeof FIELD_SPECS)
      : ocrFamilyForDocType(docTypeOrFamily);
  const targets = collectTargets(root);

  const fields: OcrField[] = [];
  if (family) {
    for (const spec of FIELD_SPECS[family]) {
      const value = pick(targets, spec.keys);
      if (value) fields.push({ label: spec.label, value });
    }
    if (family === "aadhaar") {
      const addr = pickAddress(targets);
      if (addr) fields.push({ label: "Address", value: addr });
    }
  }

  // Generic fallback: surface a few primitive fields we haven't already shown,
  // skipping noise (raw OCR text, source markers, base64 image blobs).
  if (fields.length === 0) {
    const seen = new Set(fields.map((f) => f.label.toLowerCase()));
    for (const [k, v] of Object.entries(root)) {
      if (fields.length >= 8) break;
      if (/raw|text|source|base64|photo|image|signature/i.test(k)) continue;
      if (typeof v === "string" && v.trim() && v.length <= 120) {
        const label = k.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        if (!seen.has(label.toLowerCase())) fields.push({ label, value: v.trim() });
      } else if (typeof v === "number" && Number.isFinite(v)) {
        const label = k.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        fields.push({ label, value: String(v) });
      }
    }
  }

  return fields;
}
