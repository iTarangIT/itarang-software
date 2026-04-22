// Per-field validators applied to the output of parseAadhaarText() when
// we use Tesseract as a fallback to Decentro. The previous (removed)
// fallback merged regex output into Decentro's clean fields in parallel
// and produced garbage like "Full Name: Ear Address" — these validators
// are the guardrail that keeps that class of bug from coming back.
//
// Rule of thumb: drop a field (return empty) rather than return a value
// we're not confident in. Leaving a field blank is strictly better than
// auto-filling the form with a plausible-looking wrong answer.

const NAME_BLACKLIST = [
    "address",
    "pin",
    "india",
    "government",
    "unique",
    "identification",
    "authority",
    "male",
    "female",
    "dob",
    "s/o",
    "d/o",
    "w/o",
    "c/o",
    "year",
    "birth",
    "mother",
    "father",
    "husband",
    "issued",
    "date",
    "aadhaar",
    "uidai",
];

// A "real word" must be at least 3 chars, all alphabetic, and contain
// at least one vowel (English-Latin vowels A/E/I/O/U, counting Y as a
// vowel). Tesseract's garbage English renders of Devanagari glyphs is
// almost always consonant clusters like "Fw", "Rrarsh", "HERTSE" — the
// vowel test kills most of them cheaply without a dictionary.
function isRealWord(word: string): boolean {
    if (word.length < 3) return false;
    if (!/^[A-Za-z]+$/.test(word)) return false;
    if (!/[AEIOUYaeiouy]/.test(word)) return false;
    // Reject sequences of >3 consonants in a row — strong OCR-garbage
    // signal (e.g. "Rrarsh", "HERTSE" stripped of vowels still fits).
    if (/[BCDFGHJKLMNPQRSTVWXZbcdfghjklmnpqrstvwxz]{4,}/.test(word)) return false;
    return true;
}

function looksLikeName(value: string): boolean {
    const trimmed = value.trim().replace(/\s+/g, " ");
    if (trimmed.length < 5 || trimmed.length > 60) return false;
    if (!/^[A-Za-z][A-Za-z .\-]{4,59}$/.test(trimmed)) return false;
    if (/\d/.test(trimmed)) return false;

    const lower = trimmed.toLowerCase();
    if (NAME_BLACKLIST.some((tok) => lower.includes(tok))) return false;

    // Must be ≥ 2 words — a single token (even a clean "Rushikesh") on a
    // bilingual Aadhaar front is overwhelmingly an OCR misread of the
    // Devanagari line, not the real English name line. This is the single
    // most effective filter against fallback garbage.
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length < 2) return false;

    // Every word must be a plausible real word. "Rrarsh Fw" fails here
    // because "Fw" is < 3 chars; "Lod Xyz" fails because a single-word
    // strip earlier already dropped it.
    if (!words.every(isRealWord)) return false;

    return true;
}

export function validateFullName(value: string | undefined): string {
    if (!value) return "";
    return looksLikeName(value) ? value.replace(/\s+/g, " ").trim() : "";
}

export function validateFatherName(value: string | undefined): string {
    // The parseAadhaarText regex already requires S/O|D/O|W/O|C/O on the
    // source line, so by the time we see `value` here it's the captured
    // name portion. Apply the same name rules to filter garbage captures.
    if (!value) return "";
    return looksLikeName(value) ? value.replace(/\s+/g, " ").trim() : "";
}

export function validateDob(value: string | undefined): string {
    if (!value) return "";
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return "";
    const [, yyyy, mm, dd] = m;
    const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return "";
    const year = Number(yyyy);
    const nowYear = new Date().getUTCFullYear();
    // Reject dates that are clearly not a date-of-birth (issue dates,
    // dates for a 3-year-old dealer, etc.).
    if (year < 1920 || year > nowYear - 10) return "";
    return value;
}

// Indian state names that commonly appear at the end of Aadhaar
// addresses. Used as a confidence anchor — if the OCR'd address contains
// one of these, we're reasonably sure we're looking at a real address
// and not OCR noise. Lowercase for case-insensitive matching.
const INDIAN_STATES = [
    "andhra pradesh",
    "arunachal pradesh",
    "assam",
    "bihar",
    "chhattisgarh",
    "goa",
    "gujarat",
    "haryana",
    "himachal pradesh",
    "jharkhand",
    "karnataka",
    "kerala",
    "madhya pradesh",
    "maharashtra",
    "manipur",
    "meghalaya",
    "mizoram",
    "nagaland",
    "odisha",
    "punjab",
    "rajasthan",
    "sikkim",
    "tamil nadu",
    "telangana",
    "tripura",
    "uttar pradesh",
    "uttarakhand",
    "west bengal",
    "delhi",
    "jammu and kashmir",
    "ladakh",
    "chandigarh",
    "puducherry",
];

// Scrub obvious OCR-noise tokens out of an address string. Keeps the
// real location tokens and drops things that look like Tesseract's
// garbage renders of Devanagari glyphs (short all-caps blobs, digit-
// letter mixes, lone 2-char tokens).
function scrubAddressTokens(address: string): string {
    const tokens = address.split(/,\s*/);
    const kept = tokens.filter((raw) => {
        const token = raw.trim();
        if (!token) return false;
        // 6-digit PIN always stays.
        if (/^\d{6}$/.test(token)) return true;
        // Pure digit runs other than 6-digit PIN are noise.
        if (/^\d+$/.test(token)) return false;
        // Digit-letter mixes like "39mg", "422304 Nashik" → we keep
        // any that contain a 6-digit PIN (covers the "422304 Nashik"
        // case where PIN and state ran together), else drop if the
        // digit ratio is high.
        if (/\b\d{6}\b/.test(token)) return true;
        if (/\d/.test(token)) {
            const digits = (token.match(/\d/g) ?? []).length;
            const letters = (token.match(/[A-Za-z]/g) ?? []).length;
            if (digits > letters) return false;
        }
        // Drop all-caps noise like "HERTSE", "ARE", "AEE" — real address
        // components are almost always TitleCase or mixed case. Genuine
        // city names like "NASHIK" in all-caps would survive if ≥ 5
        // chars AND vowel-bearing.
        if (/^[A-Z]+$/.test(token)) {
            if (token.length < 5) return false;
            if (!/[AEIOUY]/.test(token)) return false;
        }
        // Drop lone very-short tokens (< 3 chars) — they never carry
        // address information and are almost always Tesseract fragments.
        if (token.length < 3) return false;
        // Must contain at least one 3+ char alphabetic run — filters
        // junk like "ar-", ". y".
        if (!/[A-Za-z]{3,}/.test(token)) return false;
        return true;
    });
    return kept
        .map((t) => t.trim())
        .filter(Boolean)
        .join(", ")
        .replace(/\s+/g, " ")
        .trim();
}

export function validateAddress(value: string | undefined): string {
    if (!value) return "";
    const cleaned = scrubAddressTokens(value.replace(/\s+/g, " ").trim());
    if (cleaned.length < 25) return "";

    const lower = cleaned.toLowerCase();
    const hasPin = /\b\d{6}\b/.test(cleaned);
    const hasState = INDIAN_STATES.some((s) => lower.includes(s));

    // Real Aadhaar addresses nearly always end with "<state>, <6-digit
    // PIN>". Require both anchors together as strong evidence we're
    // looking at an actual address and not OCR detritus. Falling back
    // to "PIN alone" was letting garbage through.
    if (!hasPin || !hasState) return "";

    return cleaned;
}

export function validateAadhaarNumber(value: string | undefined): string {
    if (!value) return "";
    const digits = value.replace(/\D/g, "");
    if (digits.length !== 12) return "";
    // UIDAI's Verhoeff check would be ideal, but lots of printed cards
    // fail OCR on the last group. 12-digits + "not all same digit" is
    // the pragmatic middle ground.
    if (/^(\d)\1{11}$/.test(digits)) return "";
    return digits;
}

export function validateGender(value: string | undefined): "Male" | "Female" | "Transgender" | "" {
    if (!value) return "";
    const v = value.trim().toLowerCase();
    if (v === "male") return "Male";
    if (v === "female") return "Female";
    if (v === "transgender") return "Transgender";
    return "";
}
