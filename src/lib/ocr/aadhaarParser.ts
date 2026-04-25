export type AadhaarParsed = {
    fullName?: string;
    fatherName?: string;
    dob?: string; // yyyy-mm-dd
    address?: string;
    aadhaarNumber?: string; // 12 digits, no separators
    gender?: string;
};

function toIsoDob(raw: string): string | undefined {
    const m = raw.match(/\b(\d{2})[\/\-](\d{2})[\/\-](\d{4})\b/);
    if (!m) return undefined;
    return `${m[3]}-${m[2]}-${m[1]}`;
}

// Score a candidate full-name line. Higher is better. Returns -Infinity
// if the line is definitely not a name so callers can skip it cheaply.
// Chosen heuristics match real printed Aadhaar names (two+ TitleCase
// words, no digits, no all-caps headings, no short OCR-garbage tokens).
function scoreNameCandidate(line: string): number {
    const trimmed = line.trim();
    if (trimmed.length < 5 || trimmed.length > 50) return -Infinity;
    if (!/^[A-Za-z.\- ]{5,50}$/.test(trimmed)) return -Infinity;
    if (/\d/.test(trimmed)) return -Infinity;

    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length < 2) return -Infinity;
    if (!words.every((w) => w.length >= 3)) return -Infinity;
    if (!words.every((w) => /[AEIOUYaeiouy]/.test(w))) return -Infinity;

    let score = 0;
    score += words.length * 2; // 2+ words is good; 3-word names common
    // Prefer TitleCase ("Rushikesh Shivaji Kasav") over all-caps
    // headings ("GOVERNMENT OF INDIA") or lowercase blobs.
    const titleCase = words.every((w) => /^[A-Z][a-z]+/.test(w));
    if (titleCase) score += 10;
    const allCaps = words.every((w) => /^[A-Z]+$/.test(w));
    if (allCaps) score -= 5;
    // Penalise headings that occasionally pass the character test.
    const lower = trimmed.toLowerCase();
    const headingTokens = [
        "government",
        "india",
        "unique",
        "identification",
        "authority",
        "address",
        "male",
        "female",
        "aadhaar",
    ];
    if (headingTokens.some((t) => lower.includes(t))) score -= 20;
    return score;
}

export function parseAadhaarText(text: string): AadhaarParsed {
    const lines = text
        .replace(/\r/g, "\n")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

    // DOB
    let dob: string | undefined;
    for (const l of lines) {
        const iso = toIsoDob(l);
        if (iso) { dob = iso; break; }
    }

    // Name: score every candidate line in the top 20 and take the best.
    // "First matching line" was picking Tesseract's misread of the
    // Devanagari name row over the real English one on bilingual cards.
    let fullName: string | undefined;
    let bestScore = -Infinity;
    for (const l of lines.slice(0, 20)) {
        const s = scoreNameCandidate(l);
        if (s > bestScore) {
            bestScore = s;
            fullName = l.replace(/\s+/g, " ").trim();
        }
    }
    if (bestScore === -Infinity) fullName = undefined;

    // Father/Husband (S/O D/O W/O). Stop at first comma so address
    // fragments on the same line don't get absorbed into the name.
    let fatherName: string | undefined;
    for (const l of lines) {
        const m = l.match(/\b(S\/O|D\/O|W\/O|C\/O)\b[:\-\s]*([A-Za-z .]{3,60})(?:,|$)/i);
        if (m) { fatherName = m[2].replace(/\s+/g, " ").trim(); break; }
    }

    // Address: take the lines AFTER an "Address" anchor, but keep only
    // lines that contain at least one real-looking address component
    // (3+ char alphabetic run, or a 6-digit PIN). Drops Devanagari-
    // misread-as-English garbage lines that sit between the real
    // address lines on bilingual backs.
    let address: string | undefined;
    const anchorIdx = lines.findIndex((l) => /\baddress\b/i.test(l));
    if (anchorIdx >= 0) {
        const chunk = lines
            .slice(anchorIdx + 1, anchorIdx + 10)
            .filter((l) => /[A-Za-z]{3,}/.test(l) || /\b\d{6}\b/.test(l))
            .join(", ")
            .trim();
        if (chunk.length > 10) address = chunk;
    }

    // Aadhaar number: 12 digits, usually printed with two-space separators
    // between the three groups on the front. Accept any whitespace.
    let aadhaarNumber: string | undefined;
    for (const l of lines) {
        const m = l.match(/\b(\d{4})\s+(\d{4})\s+(\d{4})\b/);
        if (m) { aadhaarNumber = `${m[1]}${m[2]}${m[3]}`; break; }
    }

    // Gender
    let gender: string | undefined;
    for (const l of lines) {
        const m = l.match(/\b(Male|Female|Transgender)\b/i);
        if (m) { gender = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase(); break; }
    }

    return { fullName, fatherName, dob, address, aadhaarNumber, gender };
}
