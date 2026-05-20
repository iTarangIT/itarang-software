// Module 3 — bulk CSV upload parsing, validation, and dedupe (BRD §0.4).
//
// parseCsv()        — RFC-4180-ish parser → UploadParsedRow[].
// validateUpload()  — per-row validation + phone-dedupe classification against
//                     existing dealer_leads. Location is validated against the
//                     E-108 cities / city_aliases tables (graceful: a miss is
//                     a suggestion, never a hard reject).
//
// The result feeds both the validate preview and the commit insert — commit
// re-runs validateUpload server-side so it never trusts client classification.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    UPLOAD_SEGMENTS,
    type UploadInsertPayload,
    type UploadParsedRow,
    type UploadRowResult,
    type UploadValidationResult,
} from "./types";

export const MAX_UPLOAD_ROWS = 5000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── CSV parsing ────────────────────────────────────────────────────────────

function parseCsvGrid(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += ch;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ",") {
            row.push(field);
            field = "";
        } else if (ch === "\r") {
            // ignore — handled by \n
        } else if (ch === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else {
            field += ch;
        }
    }
    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

// Header aliases → canonical UploadParsedRow keys.
const HEADER_MAP: Record<string, keyof UploadParsedRow> = {
    phone: "phone",
    phone_number: "phone",
    mobile: "phone",
    dealer_name: "dealer_name",
    dealer: "dealer_name",
    name: "dealer_name",
    city: "city",
    state: "state",
    contact_person: "contact_person",
    contact: "contact_person",
    email: "email",
    segment: "segment",
    segments: "segment",
    monthly_capacity: "monthly_capacity",
    capacity: "monthly_capacity",
    current_supplier: "current_supplier",
    supplier: "current_supplier",
    language: "language",
    source_label: "source_label",
    source: "source_label",
    preliminary_payment_intent: "preliminary_payment_intent",
    payment_intent: "preliminary_payment_intent",
    prior_call_notes: "prior_call_notes",
    notes: "prior_call_notes",
};

export function parseCsv(text: string): UploadParsedRow[] {
    const grid = parseCsvGrid(text.trim());
    if (grid.length < 2) return [];
    const header = grid[0].map((h) =>
        h.trim().toLowerCase().replace(/[\s-]+/g, "_"),
    );
    const out: UploadParsedRow[] = [];
    for (let i = 1; i < grid.length; i++) {
        const cells = grid[i];
        if (cells.every((c) => c.trim() === "")) continue;
        const row: Record<string, string> = {};
        header.forEach((h, idx) => {
            const key = HEADER_MAP[h];
            if (key) row[key] = (cells[idx] ?? "").trim();
        });
        out.push({ row_number: i + 1, ...row } as UploadParsedRow);
    }
    return out;
}

// ── Phone normalisation ────────────────────────────────────────────────────

// BRD §0.2/§0.4 — store as +91XXXXXXXXXX (E.164), 10 digits after the prefix.
export function normalizePhone(raw: string): string | null {
    const digits = (raw ?? "").replace(/\D/g, "");
    let ten: string | null = null;
    if (digits.length === 10) ten = digits;
    else if (digits.length === 12 && digits.startsWith("91"))
        ten = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith("0"))
        ten = digits.slice(1);
    if (!ten || !/^[6-9]\d{9}$/.test(ten)) return null;
    return `+91${ten}`;
}

function parseSegments(raw: string | undefined): string[] {
    if (!raw) return [];
    const canon = new Map(UPLOAD_SEGMENTS.map((s) => [s.toLowerCase(), s]));
    return raw
        .split(",")
        .map((s) => canon.get(s.trim().toLowerCase()))
        .filter((s): s is string => !!s);
}

// ── Validation + dedupe ────────────────────────────────────────────────────

export async function validateUpload(
    rows: UploadParsedRow[],
): Promise<UploadValidationResult> {
    // 1. Resolve all phones once.
    const normByRow = rows.map((r) => normalizePhone(r.phone ?? ""));
    const validPhones = [...new Set(normByRow.filter((p): p is string => !!p))];

    // Existing dealer_leads matching any uploaded phone.
    type ExistingLead = {
        id: string;
        phone: string;
        lead_status: string | null;
        city: string | null;
        state: string | null;
    };
    const existing =
        validPhones.length > 0
            ? ((await db.execute<ExistingLead>(sql`
                  SELECT id, phone, lead_status, city, state
                  FROM dealer_leads
                  WHERE phone = ANY(${validPhones})
              `)) as unknown as ExistingLead[])
            : [];
    const existingByPhone = new Map(existing.map((e) => [e.phone, e]));

    // City-alias suggestions (E-108). A miss is fine — free text is accepted.
    const cityInputs = [
        ...new Set(
            rows
                .map((r) => (r.city ?? "").trim().toLowerCase())
                .filter(Boolean),
        ),
    ];
    const cityCanon = new Map<string, string>();
    if (cityInputs.length > 0) {
        try {
            const aliasRows = (await db.execute<{
                alias_lower: string;
                name: string;
            }>(sql`
                SELECT ca.alias_lower, c.name
                FROM city_aliases ca
                JOIN cities c ON c.id = ca.city_id
                WHERE ca.alias_lower = ANY(${cityInputs})
            `)) as unknown as { alias_lower: string; name: string }[];
            for (const a of aliasRows) cityCanon.set(a.alias_lower, a.name);
        } catch {
            // cities/city_aliases not present — skip location enrichment.
        }
    }

    // 2. Classify each row.
    const seenInBatch = new Set<string>();
    const out: UploadRowResult[] = rows.map((r, idx) => {
        const errors: string[] = [];
        const phone = normByRow[idx];
        const dealerName = (r.dealer_name ?? "").trim();
        const city = (r.city ?? "").trim();
        const state = (r.state ?? "").trim();

        if (!phone) errors.push("Invalid phone — need a 10-digit Indian mobile.");
        if (!dealerName) errors.push("dealer_name is required.");
        if (!city) errors.push("city is required.");
        if (!state) errors.push("state is required.");
        if (r.email && !EMAIL_RE.test(r.email.trim())) {
            errors.push("email is not a valid address.");
        }

        // In-batch duplicate phone.
        if (phone && seenInBatch.has(phone)) {
            errors.push("Duplicate phone within this file.");
        }
        if (phone) seenInBatch.add(phone);

        const suggestion = city
            ? (cityCanon.get(city.toLowerCase()) ?? null)
            : null;
        const locationSuggestion =
            suggestion && suggestion.toLowerCase() !== city.toLowerCase()
                ? suggestion
                : null;

        if (errors.length > 0) {
            return {
                row_number: r.row_number,
                dealer_name: dealerName,
                normalized_phone: phone,
                city,
                state,
                status: "error",
                errors,
                location_suggestion: locationSuggestion,
                duplicate_lead_id: null,
                payload: null,
            };
        }

        const payload: UploadInsertPayload = {
            phone: phone!,
            dealer_name: dealerName,
            city,
            state,
            contact_person: r.contact_person?.trim() || null,
            email: r.email?.trim() || null,
            segments: parseSegments(r.segment),
            monthly_capacity: r.monthly_capacity
                ? Number(r.monthly_capacity.replace(/\D/g, "")) || null
                : null,
            current_supplier: r.current_supplier?.trim() || null,
            language: r.language?.trim() || "Hindi",
            preliminary_payment_intent:
                r.preliminary_payment_intent?.trim() || null,
            prior_call_notes: r.prior_call_notes?.trim() || null,
            source_label: r.source_label?.trim() || null,
        };

        // Dedupe against existing dealer_leads (BRD §0.4).
        const match = phone ? existingByPhone.get(phone) : undefined;
        let status: UploadRowResult["status"] = "valid";
        let duplicateLeadId: string | null = null;
        if (match) {
            duplicateLeadId = match.id;
            if (match.lead_status === "Lost") {
                status = "reactivate";
            } else if (
                match.city &&
                match.city.trim().toLowerCase() !== city.toLowerCase()
            ) {
                status = "address_mismatch";
            } else {
                status = "duplicate_skip";
            }
        }

        return {
            row_number: r.row_number,
            dealer_name: dealerName,
            normalized_phone: phone,
            city,
            state,
            status,
            errors: [],
            location_suggestion: locationSuggestion,
            duplicate_lead_id: duplicateLeadId,
            payload,
        };
    });

    const count = (s: UploadRowResult["status"]) =>
        out.filter((r) => r.status === s).length;

    return {
        total_rows: out.length,
        valid_rows: count("valid"),
        errored_rows: count("error"),
        duplicate_rows: count("duplicate_skip"),
        address_mismatch_rows: count("address_mismatch"),
        reactivate_rows: count("reactivate"),
        rows: out,
    };
}
