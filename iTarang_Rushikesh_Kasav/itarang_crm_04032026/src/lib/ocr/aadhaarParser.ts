export type AadhaarParsed = {
    fullName?: string;
    fatherName?: string;
    dob?: string; // yyyy-mm-dd
    address?: string;
};

function toIsoDob(raw: string): string | undefined {
    const m = raw.match(/\b(\d{2})[\/\-](\d{2})[\/\-](\d{4})\b/);
    if (!m) return undefined;
    return `${m[3]}-${m[2]}-${m[1]}`;
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

    // Name (top-most clean name line)
    const top = lines.slice(0, 15);
    const fullName =
        top.find((l) => /^[A-Za-z.\- ]{3,50}$/.test(l))?.replace(/\s+/g, " ").trim();

    // Father/Husband (S/O D/O W/O)
    let fatherName: string | undefined;
    for (const l of lines) {
        const m = l.match(/\b(S\/O|D\/O|W\/O)\b[:\- ]*(.+)$/i);
        if (m) { fatherName = m[2].replace(/\s+/g, " ").trim(); break; }
    }

    // Address: lines after "Address"
    let address: string | undefined;
    for (let i = 0; i < lines.length; i++) {
        if (/address/i.test(lines[i])) {
            const chunk = lines.slice(i + 1, i + 6).join(", ").trim();
            if (chunk.length > 10) { address = chunk; break; }
        }
    }

    return { fullName, fatherName, dob, address };
}
