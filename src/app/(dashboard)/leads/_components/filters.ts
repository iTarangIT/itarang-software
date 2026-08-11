// Filter state for the merged Leads tab. Kept in its own module so the page,
// the filter bar and the stat cards all share one shape and one set of
// query-param names.

import type { IntentBucket } from "@/lib/leads/intentBucket";

export type LeadFilters = {
    search: string;
    /** lead_status pipeline stage, or UNASSIGNED_FILTER. Labelled "Qualification". */
    status: string;
    intent: "" | IntentBucket;
    ownerId: string;
    asmId: string;
    source: string;
    state: string;
    city: string;
    /** created_at range, YYYY-MM-DD. */
    from: string;
    to: string;
    hasPhone: boolean;
};

export const EMPTY_FILTERS: LeadFilters = {
    search: "",
    status: "",
    intent: "",
    ownerId: "",
    asmId: "",
    source: "",
    state: "",
    city: "",
    from: "",
    to: "",
    hasPhone: false,
};

// Filters tucked behind the "More filters" disclosure. Counted for the badge so
// a filter that is doing work can never be invisible.
export const SECONDARY_KEYS: (keyof LeadFilters)[] = [
    "asmId",
    "source",
    "state",
    "city",
    "hasPhone",
];

export function isFilterSet(f: LeadFilters, key: keyof LeadFilters): boolean {
    const v = f[key];
    return typeof v === "boolean" ? v : v !== "";
}

export function countSecondary(f: LeadFilters): number {
    return SECONDARY_KEYS.filter((k) => isFilterSet(f, k)).length;
}

export function hasAnyFilter(f: LeadFilters): boolean {
    return (Object.keys(EMPTY_FILTERS) as (keyof LeadFilters)[]).some((k) =>
        isFilterSet(f, k),
    );
}

/**
 * Query-string names. These MUST match what GET /api/dealer-leads reads AND the
 * names the old /admin/leads-info page used, so its redirect can pass params
 * straight through and every bookmarked filtered view survives the merge.
 */
export function toSearchParams(
    f: LeadFilters,
    page: number,
    limit: number,
): URLSearchParams {
    const p = new URLSearchParams();
    p.set("page", String(page));
    p.set("limit", String(limit));
    if (f.search) p.set("search", f.search);
    if (f.status) p.set("status", f.status);
    if (f.intent) p.set("intent", f.intent);
    if (f.ownerId) p.set("owner_id", f.ownerId);
    if (f.asmId) p.set("asm_id", f.asmId);
    if (f.source) p.set("source", f.source);
    if (f.state) p.set("state", f.state);
    if (f.city) p.set("city", f.city);
    if (f.from) p.set("from", f.from);
    if (f.to) p.set("to", f.to);
    if (f.hasPhone) p.set("has_phone", "1");
    return p;
}

/** Seed filter state from a URL — used for the /admin/leads-info redirect. */
export function fromSearchParams(sp: URLSearchParams): LeadFilters {
    const intent = sp.get("intent");
    return {
        ...EMPTY_FILTERS,
        search: sp.get("search") ?? "",
        status: sp.get("status") ?? "",
        intent:
            intent === "hot" || intent === "warm" || intent === "cold" ? intent : "",
        ownerId: sp.get("owner_id") ?? "",
        asmId: sp.get("asm_id") ?? "",
        source: sp.get("source") ?? "",
        state: sp.get("state") ?? "",
        city: sp.get("city") ?? "",
        from: sp.get("from") ?? "",
        to: sp.get("to") ?? "",
        hasPhone: sp.get("has_phone") === "1",
    };
}
