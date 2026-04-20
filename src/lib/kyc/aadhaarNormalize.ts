// Normalization helpers for Aadhaar data extracted from Decentro (OCR or
// DigiLocker eAadhaar). Both code paths need to hand the lead form an
// identical snake_case + camelCase object so downstream prefill logic is
// a single implementation.

export function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export function normalizeDate(value: string): string {
    if (!value) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const m = value.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
    if (m) {
        const [, dd, mm, yyyy] = m;
        return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
    }
    return value.trim();
}

export function firstNonEmpty(...values: unknown[]): string {
    for (const value of values) {
        const v = clean(value);
        if (v) return v;
    }
    return "";
}

export function getDeep(obj: unknown, paths: string[]): string {
    for (const path of paths) {
        const value = path
            .split(".")
            .reduce<unknown>((acc, key) => {
                if (acc && typeof acc === "object") {
                    return (acc as Record<string, unknown>)[key];
                }
                return undefined;
            }, obj);
        const cleaned = clean(value);
        if (cleaned) return cleaned;
    }
    return "";
}

export interface StructuredAadhaar {
    fullName: string;
    fatherName: string;
    dob: string;
    phone: string;
    address: string;
    aadhaarNumber: string;
    rawText: string;
}

// Decentro responses nest Aadhaar fields at different paths across API
// versions and product lines (OCR vs DigiLocker eAadhaar). Walk every
// known shape defensively.
//
// DigiLocker eAadhaar shape (observed from the prod API):
//   data.proofOfIdentity.{name, dob, gender}
//   data.proofOfAddress.{careOf, house, street, landmark, locality,
//                        postOffice, district, state, pincode, country,
//                        subDistrict}
//   data.aadhaarReferenceNumber   // often empty — UIDAI rarely returns
//                                 //   the full UID via DigiLocker
export function extractStructuredAadhaar(payload: unknown): StructuredAadhaar {
    return {
        fullName: firstNonEmpty(
            getDeep(payload, [
                "ocrResult.name",
                "data.proofOfIdentity.name",
                "data.full_name",
                "data.name",
                "data.customer_name",
                "data.nameOnCard",
                "response.full_name",
                "response.name",
                "result.full_name",
                "result.name",
            ]),
        ),
        fatherName: firstNonEmpty(
            getDeep(payload, [
                "ocrResult.fatherName",
                "ocrResult.sonOf",
                "ocrResult.husbandOf",
                "data.proofOfAddress.careOf",
                "data.father_name",
                "data.fatherName",
                "data.father_or_husband_name",
                "data.fatherOrHusbandName",
                "data.careof",
                "data.care_of",
                "response.father_name",
                "result.father_name",
            ]),
        ),
        dob: normalizeDate(
            firstNonEmpty(
                getDeep(payload, [
                    "ocrResult.dateInfo",
                    "data.proofOfIdentity.dob",
                    "data.dob",
                    "data.date_of_birth",
                    "data.dateOfBirth",
                    "response.dob",
                    "result.dob",
                ]),
            ),
        ),
        phone: firstNonEmpty(
            getDeep(payload, [
                "data.phone",
                "data.mobile",
                "data.mobile_number",
                "response.phone",
                "result.phone",
            ]),
        ),
        address: firstNonEmpty(
            getDeep(payload, [
                "ocrResult.address",
                "data.address",
                "data.full_address",
                "data.current_address",
                "data.currentAddress",
                "response.address",
                "result.address",
            ]),
            // DigiLocker returns address as nested components, not a
            // flat string. Build one up from them as a fallback.
            buildAddressFromDigilockerComponents(payload),
        ),
        aadhaarNumber: firstNonEmpty(
            getDeep(payload, [
                "ocrResult.aadhaarNumber",
                // DigiLocker returns a masked UID like "xxxxxxxx8015" here.
                // `aadhaarReferenceNumber` is usually empty unless full UID
                // is consented to — we still check it as a fallback.
                "data.aadhaarUid",
                "data.aadhaarReferenceNumber",
                "data.aadhaar_number",
                "data.aadhaarNumber",
                "data.uid",
                "response.aadhaar_number",
                "result.aadhaar_number",
            ]),
        ),
        rawText: firstNonEmpty(
            getDeep(payload, [
                "data.ocr_text",
                "data.raw_text",
                "data.text",
                "response.ocr_text",
                "response.raw_text",
                "response.text",
                "ocr_text",
                "raw_text",
                "text",
            ]),
        ),
    };
}

// Join proofOfAddress components into a single human-readable address.
// Skips empty parts so we never emit ", , ," runs.
function buildAddressFromDigilockerComponents(payload: unknown): string {
    const parts = [
        getDeep(payload, ["data.proofOfAddress.house"]),
        getDeep(payload, ["data.proofOfAddress.street"]),
        getDeep(payload, ["data.proofOfAddress.landmark"]),
        getDeep(payload, ["data.proofOfAddress.locality"]),
        getDeep(payload, ["data.proofOfAddress.postOffice"]),
        getDeep(payload, ["data.proofOfAddress.subDistrict"]),
        getDeep(payload, ["data.proofOfAddress.district"]),
        getDeep(payload, ["data.proofOfAddress.state"]),
        getDeep(payload, ["data.proofOfAddress.pincode"]),
    ].filter((s) => s && s.trim());
    return parts.join(", ");
}

// If the structured OCR didn't give us a father name, some Aadhaars print
// it inline in the address as "S/O: <name>, ...". Pick that out.
export function extractFatherFromAddress(address: string): string {
    if (!address) return "";
    const pattern = /[SDWC]\/[Oo]:?\s+([^,]+)/g;
    const matches: string[] = [];
    let m;
    while ((m = pattern.exec(address)) !== null) {
        const name = m[1].trim();
        const latinChars = name.replace(/[^A-Za-z]/g, "").length;
        const totalChars = name.replace(/[\s]/g, "").length;
        if (totalChars > 0 && latinChars / totalChars > 0.7) {
            const cleanedName = name.replace(/[^A-Za-z\s]/g, "").trim();
            // Each word must be 3+ chars to filter OCR garbage
            const words = cleanedName.split(" ").filter((w) => w.length >= 3);
            if (words.length >= 1) {
                matches.push(
                    words
                        .map(
                            (w) =>
                                w.charAt(0).toUpperCase() +
                                w.slice(1).toLowerCase(),
                        )
                        .join(" "),
                );
            }
        }
    }
    return matches.length > 0 ? matches[matches.length - 1] : "";
}

// Strip OCR/eAadhaar garbage from address strings (UIDAI watermarks,
// URLs, the Aadhaar number when it leaks in, stray pipes/punctuation).
export function cleanAddress(address: string): string {
    if (!address) return "";
    let cleaned = address.replace(/[SDWC]\/[Oo]:?\s+[^,]+,\s*/g, "");
    cleaned = cleaned
        .replace(/\b[|]\s*/g, "")
        .replace(/[™®©]/g, "")
        .replace(/\bwww\.[^\s,]+/gi, "")
        .replace(/help@[^\s,]+/gi, "")
        .replace(/\b\d{4}\s?\d{4}\s?\d{4}\b/g, "")
        .replace(/,\s*,/g, ",")
        .replace(/,\s*$/g, "")
        .replace(/^\s*,\s*/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return cleaned;
}

export interface FinalAadhaarData {
    // snake_case (consumed directly by lead form)
    full_name: string;
    father_or_husband_name: string;
    current_address: string;
    permanent_address: string;
    phone: string;
    dob: string;
    aadhaar_number: string;
    // camelCase aliases for other call sites
    fullName: string;
    fatherName: string;
    address: string;
    aadhaarNumber: string;
    // Allows iteration via Object.values / dynamic access.
    [key: string]: string;
}

// Merge all sources (Decentro structured, Aadhaar-text regex of raw OCR,
// or DigiLocker eAadhaar) into one normalized object. Prefer "front"
// structures for identity fields, "back" for address.
export function buildFinalData(
    frontStructured: StructuredAadhaar,
    backStructured: StructuredAadhaar,
    frontParsed: Partial<StructuredAadhaar> = {},
    backParsed: Partial<StructuredAadhaar> = {},
): FinalAadhaarData {
    const rawAddress = firstNonEmpty(
        backStructured.address,
        frontStructured.address,
        backParsed?.address,
        frontParsed?.address,
    );
    const fatherFromAddress = extractFatherFromAddress(rawAddress);
    const cleanedAddress = rawAddress ? cleanAddress(rawAddress) : "";

    const fullName = firstNonEmpty(
        frontStructured.fullName,
        backStructured.fullName,
        frontParsed?.fullName,
        backParsed?.fullName,
    );
    const fatherName = firstNonEmpty(
        frontStructured.fatherName,
        backStructured.fatherName,
        frontParsed?.fatherName,
        backParsed?.fatherName,
        fatherFromAddress,
    );
    const phone = firstNonEmpty(
        frontStructured.phone,
        backStructured.phone,
        frontParsed?.phone,
        backParsed?.phone,
    );
    const dob = normalizeDate(
        firstNonEmpty(
            frontStructured.dob,
            backStructured.dob,
            frontParsed?.dob,
            backParsed?.dob,
        ),
    );
    const aadhaarNumber = firstNonEmpty(
        frontStructured.aadhaarNumber,
        backStructured.aadhaarNumber,
    );
    const address = cleanedAddress || rawAddress;

    return {
        full_name: fullName,
        father_or_husband_name: fatherName,
        current_address: address,
        permanent_address: address,
        phone,
        dob,
        aadhaar_number: aadhaarNumber,
        fullName,
        fatherName,
        address,
        aadhaarNumber,
    };
}

export function hasUsefulData(data: Record<string, unknown>): boolean {
    return Object.values(data).some((v) => clean(v) !== "");
}
