/**
 * Lead "Segment" — which products the dealer deals in (24 Nov tree).
 *
 *   LEAD
 *   ├── Type of business  — ONE of battery_sale | buyback | scrap | other
 *   │                       (src/lib/leads/businessType.ts): what deal we do.
 *   └── Segment           — ONE OR MORE of the values below: what the dealer
 *                           sells. Required when the type is Battery Sale.
 *
 * Stored as display strings in dealer_leads.segments (jsonb array), as the
 * bulk upload always wrote them. CLIENT-SAFE (no db import).
 *
 * Older values: "3W" / "2W" (bulk upload) read as the new labels; "Auto-Parts"
 * and "Battery" are kept on the rows that have them and shown, but not offered.
 */

import { z } from "zod";

export const LEAD_SEGMENTS = ["3W batteries", "2W batteries", "Solar", "Inverter", "BESS", "ESS"] as const;
export type LeadSegment = (typeof LEAD_SEGMENTS)[number];

/** Old stored values that are still shown on the rows that carry them. */
export const LEGACY_SEGMENTS = ["Auto-Parts", "Battery"] as const;

export function isLeadSegment(v: unknown): v is LeadSegment {
    return typeof v === "string" && (LEAD_SEGMENTS as readonly string[]).includes(v);
}

const ALIASES: Record<string, LeadSegment> = {
    "3w": "3W batteries",
    "3w_batteries": "3W batteries",
    "3w_battery": "3W batteries",
    three_wheeler: "3W batteries",
    three_wheelers: "3W batteries",
    e_rickshaw: "3W batteries",
    erickshaw: "3W batteries",
    e_auto: "3W batteries",
    "2w": "2W batteries",
    "2w_batteries": "2W batteries",
    "2w_battery": "2W batteries",
    two_wheeler: "2W batteries",
    two_wheelers: "2W batteries",
    e_2w: "2W batteries",
    scooter: "2W batteries",
    solar: "Solar",
    solar_panel: "Solar",
    solar_panels: "Solar",
    inverter: "Inverter",
    inverters: "Inverter",
    inverter_battery: "Inverter",
    bess: "BESS",
    ess: "ESS",
};

/** One human-typed value → a segment, or null when unrecognised. */
export function normalizeSegment(input: unknown): LeadSegment | null {
    if (input == null) return null;
    const raw = String(input).trim();
    if (!raw) return null;
    if (isLeadSegment(raw)) return raw;
    const key = raw.toLowerCase().replace(/[\s\-/.]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
    return ALIASES[key] ?? null;
}

/** A comma-separated string or an array → unique segments, in the canonical order. */
export function parseSegments(input: unknown): LeadSegment[] {
    const parts = Array.isArray(input) ? input : typeof input === "string" ? input.split(",") : [];
    const got = new Set(parts.map(normalizeSegment).filter((s): s is LeadSegment => !!s));
    return LEAD_SEGMENTS.filter((s) => got.has(s));
}

/** Segments from a stored jsonb value: known ones normalised, legacy ones kept as they are. */
export function storedSegments(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const raw of v) {
        const seg = normalizeSegment(raw) ?? ((LEGACY_SEGMENTS as readonly string[]).includes(String(raw)) ? String(raw) : null);
        if (seg && !out.includes(seg)) out.push(seg);
    }
    return out;
}

export const SegmentsSchema = z.array(z.enum(LEAD_SEGMENTS)).max(LEAD_SEGMENTS.length);
