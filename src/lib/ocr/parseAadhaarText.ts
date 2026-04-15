export type ParsedAadhaar = {
  fullName?: string | null;
  fatherName?: string | null;
  dob?: string | null;
  gender?: string | null;
  aadhaarNumber?: string | null;
  phone?: string | null;
  address?: string | null;
  pincode?: string | null;
};

// ── Noise / known non-name phrases to skip ──────────────────────────────────
const SKIP_PHRASES = [
  "government of india",
  "unique identification",
  "authority of india",
  "uidai",
  "help@uidai",
  "www.uidai",
  "aadhaar",
  "enrolment",
  "enrollment",
  "mera aadhaar",
  "vid",
  "goal address",
];

// Indian states and UTs for address validation
const INDIAN_STATES = [
  "andhra pradesh", "arunachal pradesh", "assam", "bihar", "chhattisgarh",
  "goa", "gujarat", "haryana", "himachal pradesh", "jharkhand", "karnataka",
  "kerala", "madhya pradesh", "maharashtra", "manipur", "meghalaya", "mizoram",
  "nagaland", "odisha", "punjab", "rajasthan", "sikkim", "tamil nadu",
  "telangana", "tripura", "uttar pradesh", "uttarakhand", "west bengal",
  "delhi", "chandigarh", "jammu", "kashmir", "ladakh", "puducherry",
];

function cleanSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function titleCase(value: string): string {
  return cleanSpaces(value)
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeText(rawText: string): { text: string; lines: string[] } {
  const lines = rawText
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => cleanSpaces(line))
    .filter(Boolean);

  return {
    text: cleanSpaces(lines.join(" ")),
    lines,
  };
}

function formatDob(raw: string): string | null {
  const cleaned = raw.replace(/[^\d/.-]/g, "");
  const match = cleaned.match(/^(\d{2})[\/.-](\d{2})[\/.-](\d{4})$/);
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  return `${yyyy}-${mm}-${dd}`;
}

/** Check if a string is mostly non-Latin (Hindi/Devanagari garbage) */
function isNonLatin(text: string): boolean {
  const latinChars = text.replace(/[^A-Za-z]/g, "").length;
  const totalChars = text.replace(/[\s\d,.:;/\-|]/g, "").length;
  if (totalChars === 0) return true;
  return latinChars / totalChars < 0.5;
}

/** Check if a line is a known skip phrase */
function isSkipPhrase(line: string): boolean {
  const lower = line.toLowerCase();
  return SKIP_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * Check if a word/token is a clean English word (for address purposes).
 * Must be 3+ alpha chars, no digits or symbols mixed in.
 */
function isCleanEnglishWord(word: string): boolean {
  if (word.length < 3) return false;
  // Must be mostly alphabetic
  const alpha = word.replace(/[^A-Za-z]/g, "").length;
  if (alpha < 3) return false;
  if (alpha / word.length < 0.8) return false;
  // Not a known garbage word
  const lower = word.toLowerCase();
  if (["hens", "grae", "goal", "see", "aha", "erent", "tenn", "sfheeree"].includes(lower)) return false;
  return true;
}

/**
 * Pick a likely person name from lines.
 * Each word must be at least 3 chars to avoid OCR garbage like "FE", "SN"
 */
function pickLikelyName(lines: string[]): string | null {
  for (const line of lines) {
    const cleaned = line.replace(/[^A-Za-z\s]/g, "").trim();
    if (!cleaned) continue;

    if (isSkipPhrase(cleaned)) continue;
    if (isNonLatin(line)) continue;

    const words = cleaned.split(" ").filter(Boolean);
    if (words.length >= 2 && words.length <= 4) {
      const good = words.every((w) => /^[A-Za-z]+$/.test(w) && w.length >= 3);
      if (good) return titleCase(cleaned);
    }
  }
  return null;
}

/**
 * Extract father/husband name from S/O, D/O, W/O, C/O patterns.
 * Picks the cleanest English match from bilingual text.
 */
function extractRelationName(text: string): string | null {
  const pattern = /[SDWC]\/[Oo]:?\s+([^,\n]+)/g;
  const matches: string[] = [];
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const name = match[1].trim();
    if (!isNonLatin(name)) {
      const cleaned = name.replace(/[^A-Za-z\s]/g, "").trim();
      const words = cleaned.split(" ").filter((w) => w.length >= 3);
      if (words.length >= 1 && words.length <= 4) {
        matches.push(titleCase(words.join(" ")));
      }
    }
  }

  return matches.length > 0 ? matches[matches.length - 1] : null;
}

/**
 * Extract address using a whitelist approach:
 * Instead of filtering garbage OUT, we extract ONLY recognized English address fragments.
 *
 * Works by scanning the raw text for:
 * 1. "At Post <place>" patterns
 * 2. "Tal/Taluka <place>" patterns
 * 3. Known Indian state names
 * 4. Clean English place names (3+ alpha chars) near address keywords
 * 5. Pincode (6-digit number)
 */
function extractAddress(lines: string[], pincode?: string | null): string | null {
  const fullText = lines.join(" ");
  const addressParts: string[] = [];

  // 1. Extract "At Post <PlaceName>" or "At <PlaceName>"
  const atPostMatch = fullText.match(/\bAt\s+Post\s+([A-Za-z]{3,}(?:\s+[A-Za-z]{3,})*)/i);
  if (atPostMatch) {
    addressParts.push(`At Post ${titleCase(atPostMatch[1])}`);
  } else {
    const atMatch = fullText.match(/\bAt\s+([A-Z][a-zA-Z]{2,}(?:\s+[A-Za-z]{3,})*)/);
    if (atMatch && !isSkipPhrase(atMatch[1])) {
      addressParts.push(`At ${titleCase(atMatch[1])}`);
    }
  }

  // 2. Extract "Tal/Taluka <PlaceName>" (with optional - or space)
  const talMatch = fullText.match(/\bTal[.\-\s]*\s*([A-Za-z]{3,}(?:\s+[A-Za-z]{3,})*)/i);
  if (talMatch) {
    addressParts.push(`Tal ${titleCase(talMatch[1])}`);
  }

  // 3. Extract "Dist/District <PlaceName>"
  const distMatch = fullText.match(/\bDist(?:rict)?[.\-\s]*\s*([A-Za-z]{3,}(?:\s+[A-Za-z]{3,})*)/i);
  if (distMatch) {
    addressParts.push(`District ${titleCase(distMatch[1])}`);
  }

  // 4. Find place names between address markers
  //    Look for sequences of clean English words between known markers
  //    This catches city/village names like "Ugaon, Ugaon, Nashik"
  const afterTalOrPost = fullText.match(
    /(?:Tal[.\-\s]*[A-Za-z]+|At\s+Post\s+[A-Za-z]+)[,\s]+(.+?)(?:\d{6}|$)/i
  );
  if (afterTalOrPost) {
    const remaining = afterTalOrPost[1];
    const segments = remaining.split(",").map((s) => s.trim());
    for (const seg of segments) {
      // Extract only clean English words from each segment
      const words = seg.split(/\s+/).filter((w) => isCleanEnglishWord(w));
      if (words.length > 0) {
        const cleaned = titleCase(words.join(" "));
        // Don't duplicate what we already have
        if (!addressParts.some((p) => p.toLowerCase().includes(cleaned.toLowerCase()))) {
          // Check it's not a skip phrase
          if (!isSkipPhrase(cleaned)) {
            addressParts.push(cleaned);
          }
        }
      }
    }
  }

  // 5. Find Indian state name
  const lowerFull = fullText.toLowerCase();
  for (const state of INDIAN_STATES) {
    if (lowerFull.includes(state)) {
      const stateTitled = titleCase(state);
      if (!addressParts.some((p) => p.toLowerCase().includes(state))) {
        addressParts.push(stateTitled);
      }
      break;
    }
  }

  // 6. Add pincode
  if (pincode && !addressParts.some((p) => p.includes(pincode))) {
    addressParts.push(pincode);
  }

  if (addressParts.length === 0) return null;

  return addressParts.join(", ");
}

export function parseAadhaarText(rawText: string): ParsedAadhaar {
  if (!rawText) return {};

  const { text, lines } = normalizeText(rawText);

  const result: ParsedAadhaar = {
    fullName: null,
    fatherName: null,
    dob: null,
    gender: null,
    aadhaarNumber: null,
    phone: null,
    address: null,
    pincode: null,
  };

  // ── Aadhaar number ────────────────────────────────────────────────────
  const aadhaarMatch = text.match(/\b\d{4}\s?\d{4}\s?\d{4}\b/);
  if (aadhaarMatch) {
    result.aadhaarNumber = aadhaarMatch[0].replace(/\s/g, "");
  }

  // ── DOB ───────────────────────────────────────────────────────────────
  const dobMatch =
    text.match(/\bDOB[:\s-]*([0-9]{2}[\/.-][0-9]{2}[\/.-][0-9]{4})/i) ||
    text.match(/\bDate of Birth[:\s-]*([0-9]{2}[\/.-][0-9]{2}[\/.-][0-9]{4})/i) ||
    text.match(/\b([0-9]{2}\/[0-9]{2}\/[0-9]{4})\b/);
  if (dobMatch) {
    result.dob = formatDob(dobMatch[1]);
  }

  // ── Gender ────────────────────────────────────────────────────────────
  const genderMatch = text.match(/\b(Male|Female)\b/i);
  if (genderMatch) {
    result.gender = titleCase(genderMatch[0]);
  }

  // ── Phone ─────────────────────────────────────────────────────────────
  const phoneMatch = text.match(/\b[6-9]\d{9}\b/);
  if (phoneMatch) {
    result.phone = phoneMatch[0];
  }

  // ── Father / Husband name ─────────────────────────────────────────────
  result.fatherName = extractRelationName(text);

  // ── Full name ─────────────────────────────────────────────────────────
  result.fullName = pickLikelyName(lines);

  if (!result.fullName) {
    const nameBeforeDob = text.match(
      /\b([A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]{2,}){1,3})\s+[^A-Za-z]*(?:DOB|Date of Birth)/i
    );
    if (nameBeforeDob) {
      const candidate = titleCase(nameBeforeDob[1]);
      if (!isSkipPhrase(candidate)) {
        result.fullName = candidate;
      }
    }
  }

  // ── Pincode ───────────────────────────────────────────────────────────
  const pinMatches = text.match(/\b\d{6}\b/g);
  if (pinMatches?.length) {
    result.pincode = pinMatches[pinMatches.length - 1];
  }

  // ── Address ───────────────────────────────────────────────────────────
  result.address = extractAddress(lines, result.pincode);

  return result;
}
