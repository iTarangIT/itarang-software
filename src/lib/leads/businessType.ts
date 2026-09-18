/**
 * "Type of Business" on a dealer lead (E-296, `dealer_leads.business_type`).
 *
 * CLIENT-SAFE — no `db` import, so forms, filter bars and the xlsx importer can
 * all read the vocabulary. Same split as src/lib/leads/queueFilters.ts.
 *
 * The allowed values are enforced HERE (zod), not by a CHECK constraint, so the
 * list can grow without a migration. NULL is a legitimate state — every lead
 * created before E-296 has it — and renders as "Not set", never as a guess.
 *
 * ⚠ The column is NOT in schema.ts (see the dealer_leads comment there): it is
 * written by raw `sql` UPDATEs and read via `to_jsonb(dl) ->> 'business_type'`
 * or in fail-tolerant side statements, so a database without E-296 keeps
 * serving the leads list.
 */

import { z } from "zod";

export const BUSINESS_TYPES = [
    "battery_sale",
    "buyback",
    "finance",
    "scrap",
    "other",
] as const;

export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const BUSINESS_TYPE_LABELS: Record<BusinessType, string> = {
    battery_sale: "Battery Sale",
    buyback: "Buyback",
    finance: "Finance",
    scrap: "Scrap",
    other: "Other",
};

/** Label for a stored value; NULL / unknown → "Not set". */
export const BUSINESS_TYPE_UNSET_LABEL = "Not set";

/**
 * Filter sentinel for "no business type recorded" (`business_type IS NULL`).
 * Not a storable value — the zod enum below rejects it.
 */
export const BUSINESS_TYPE_UNSET = "unset";

export const BUSINESS_TYPE_OPTIONS: { value: BusinessType; label: string }[] =
    BUSINESS_TYPES.map((v) => ({ value: v, label: BUSINESS_TYPE_LABELS[v] }));

/** Chip colours (Tailwind border/bg/text), shared by the table, drawer and detail pane. */
export const BUSINESS_TYPE_TONE: Record<BusinessType, string> = {
    battery_sale: "border-emerald-200 bg-emerald-50 text-emerald-700",
    buyback: "border-violet-200 bg-violet-50 text-violet-700",
    finance: "border-sky-200 bg-sky-50 text-sky-700",
    scrap: "border-amber-200 bg-amber-50 text-amber-700",
    other: "border-gray-200 bg-gray-50 text-gray-700",
};

/** Tone for a stored value; NULL / unknown gets a muted dashed chip. */
export function businessTypeTone(v: string | null | undefined): string {
    return isBusinessType(v)
        ? BUSINESS_TYPE_TONE[v]
        : "border-dashed border-gray-200 bg-white text-gray-400";
}

export const BusinessTypeSchema = z.enum(BUSINESS_TYPES);

export function isBusinessType(v: unknown): v is BusinessType {
    return typeof v === "string" && (BUSINESS_TYPES as readonly string[]).includes(v);
}

/** A valid filter value: one of the types, or the "unset" sentinel. */
export function isBusinessTypeFilter(v: unknown): v is BusinessType | typeof BUSINESS_TYPE_UNSET {
    return v === BUSINESS_TYPE_UNSET || isBusinessType(v);
}

export function businessTypeLabel(v: string | null | undefined): string {
    return isBusinessType(v) ? BUSINESS_TYPE_LABELS[v] : BUSINESS_TYPE_UNSET_LABEL;
}

/**
 * Tolerant parser for human input — spreadsheet imports, hand-typed values.
 *
 * Accepts the stored value (`battery_sale`), the label (`Battery Sale`), and the
 * usual spelling variations (case, spaces, hyphens, a trailing "s"). Returns
 * `null` for blank input AND for anything unrecognised; callers that need to
 * tell those apart check for blank input themselves.
 */
export function normalizeBusinessType(input: unknown): BusinessType | null {
    if (input == null) return null;
    const key = String(input)
        .trim()
        .toLowerCase()
        .replace(/[\s\-/.]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "");
    if (!key) return null;
    if (isBusinessType(key)) return key;
    const ALIASES: Record<string, BusinessType> = {
        battery: "battery_sale",
        batteries: "battery_sale",
        battery_sales: "battery_sale",
        batterysale: "battery_sale",
        sale: "battery_sale",
        sales: "battery_sale",
        buy_back: "buyback",
        buybacks: "buyback",
        financing: "finance",
        loan: "finance",
        scrap_sale: "scrap",
        scrapping: "scrap",
        others: "other",
    };
    return ALIASES[key] ?? null;
}
