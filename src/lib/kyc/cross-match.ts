import { stringSimilarity, normalizeDate } from "@/lib/decentro";

export interface CrossMatchInput {
  name?: string | null;
  dob?: string | null;
  phone?: string | null;
  address?: string | null;
  gender?: string | null;
  fatherOrHusbandName?: string | null;
}

export interface CrossMatchResult {
  nameMatch: boolean;
  nameSimilarity: number;
  dobMatch: boolean;
  phoneMatch: boolean;
  addressMatch: boolean;
  addressSimilarity: number;
  genderMatch: boolean;
  fatherNameMatch: boolean;
  fatherNameSimilarity: number;
  overallPass: boolean;
  fields: CrossMatchField[];
}

export interface CrossMatchField {
  field: string;
  label: string;
  inputValue: string | null;
  documentValue: string | null;
  matchResult: "strong" | "moderate" | "mismatch";
  similarity: number;
  threshold: number;
}

const TEXT_MATCH_THRESHOLD = 80;
const FACE_STRONG_THRESHOLD = 90;
const FACE_MODERATE_THRESHOLD = 75;

function normalizePhone(phone: string | null | undefined): string {
  if (!phone) return "";
  return phone.replace(/[\s\-+]/g, "").replace(/^91/, "").slice(-10);
}

function normalizeGender(gender: string | null | undefined): string {
  if (!gender) return "";
  const g = gender.trim().toUpperCase();
  if (g === "M" || g === "MALE") return "M";
  if (g === "F" || g === "FEMALE") return "F";
  if (g === "T" || g === "TRANSGENDER") return "T";
  return g;
}

export function crossMatchAadhaarData(
  digilockerData: CrossMatchInput,
  leadData: CrossMatchInput,
): CrossMatchResult {
  const fields: CrossMatchField[] = [];

  // Name match (≥80%)
  const nameSim = stringSimilarity(
    digilockerData.name || "",
    leadData.name || "",
  );
  const nameMatch = nameSim >= TEXT_MATCH_THRESHOLD;
  fields.push({
    field: "name",
    label: "Name",
    inputValue: leadData.name || null,
    documentValue: digilockerData.name || null,
    matchResult: nameSim >= TEXT_MATCH_THRESHOLD ? "strong" : "mismatch",
    similarity: nameSim,
    threshold: TEXT_MATCH_THRESHOLD,
  });

  // DOB exact match
  const leadDob = leadData.dob ? normalizeDate(leadData.dob) : "";
  const docDob = digilockerData.dob ? normalizeDate(digilockerData.dob) : "";
  const dobMatch = !!leadDob && !!docDob && leadDob === docDob;
  fields.push({
    field: "dob",
    label: "Date of Birth",
    inputValue: leadDob || null,
    documentValue: docDob || null,
    matchResult: dobMatch ? "strong" : "mismatch",
    similarity: dobMatch ? 100 : 0,
    threshold: 100,
  });

  // Phone match
  const leadPhone = normalizePhone(leadData.phone);
  const docPhone = normalizePhone(digilockerData.phone);
  const phoneMatch = !!leadPhone && !!docPhone && leadPhone === docPhone;
  fields.push({
    field: "phone",
    label: "Mobile",
    inputValue: leadData.phone || null,
    documentValue: digilockerData.phone || null,
    matchResult: phoneMatch ? "strong" : docPhone ? "mismatch" : "moderate",
    similarity: phoneMatch ? 100 : 0,
    threshold: 100,
  });

  // Address match (≥80%)
  const addressSim = stringSimilarity(
    digilockerData.address || "",
    leadData.address || "",
  );
  const addressMatch = addressSim >= TEXT_MATCH_THRESHOLD;
  fields.push({
    field: "address",
    label: "Address",
    inputValue: leadData.address || null,
    documentValue: digilockerData.address || null,
    matchResult: addressSim >= TEXT_MATCH_THRESHOLD ? "strong" : "mismatch",
    similarity: addressSim,
    threshold: TEXT_MATCH_THRESHOLD,
  });

  // Gender match
  const genderMatch =
    normalizeGender(digilockerData.gender) ===
      normalizeGender(leadData.gender) &&
    !!digilockerData.gender;
  fields.push({
    field: "gender",
    label: "Gender",
    inputValue: leadData.gender || null,
    documentValue: digilockerData.gender || null,
    matchResult: genderMatch ? "strong" : "mismatch",
    similarity: genderMatch ? 100 : 0,
    threshold: TEXT_MATCH_THRESHOLD,
  });

  // Father/Husband name match (≥80%)
  const fatherSim = stringSimilarity(
    digilockerData.fatherOrHusbandName || "",
    leadData.fatherOrHusbandName || "",
  );
  const fatherNameMatch = fatherSim >= TEXT_MATCH_THRESHOLD;
  fields.push({
    field: "father_husband_name",
    label: "Father/Husband Name",
    inputValue: leadData.fatherOrHusbandName || null,
    documentValue: digilockerData.fatherOrHusbandName || null,
    matchResult: fatherSim >= TEXT_MATCH_THRESHOLD ? "strong" : "mismatch",
    similarity: fatherSim,
    threshold: TEXT_MATCH_THRESHOLD,
  });

  // Overall: name + DOB must match at minimum
  const overallPass = nameMatch && dobMatch;

  return {
    nameMatch,
    nameSimilarity: nameSim,
    dobMatch,
    phoneMatch,
    addressMatch,
    addressSimilarity: addressSim,
    genderMatch,
    fatherNameMatch,
    fatherNameSimilarity: fatherSim,
    overallPass,
    fields,
  };
}

export function getFaceMatchResult(
  similarity: number,
): "strong" | "moderate" | "mismatch" {
  if (similarity >= FACE_STRONG_THRESHOLD) return "strong";
  if (similarity >= FACE_MODERATE_THRESHOLD) return "moderate";
  return "mismatch";
}
