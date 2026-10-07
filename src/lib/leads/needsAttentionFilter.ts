/**
 * The Needs Attention page's filters (search, role, status, interest, minimum
 * idle days), as ONE pure function used by the page (on the rows it loaded)
 * and by the CSV route (on the same rows server-side) — so the download is
 * exactly the list on screen. The "held by" filter is not here: it narrows the
 * query itself (listNeedsAttention's holderId).
 *
 * Pure, no I/O: importable from the client component and unit-tested.
 */
import type { NeedsAttentionRow } from "./needsAttention";

export const IDLE_MIN_OPTIONS = [5, 7, 14, 30] as const;

export type NeedsAttentionFilters = {
    q?: string | null;
    /** "inside" = inside_sales_rep, "field" = asm / sales_manager, else everyone. */
    role?: string | null;
    status?: string | null;
    interest?: string | null;
    /** Only leads idle at least this many working days. */
    minDays?: number | null;
};

const FIELD_ROLES = ["asm", "sales_manager"];
const INSIDE_ROLES = ["inside_sales_rep"];

export function filterNeedsAttention(rows: NeedsAttentionRow[], f: NeedsAttentionFilters): NeedsAttentionRow[] {
    const q = (f.q ?? "").trim().toLowerCase();
    const roles = f.role === "field" ? FIELD_ROLES : f.role === "inside" ? INSIDE_ROLES : null;
    const interest = (f.interest ?? "").toLowerCase();
    return rows.filter(
        (r) =>
            (!q ||
                [r.dealer, r.city, r.holder_name, r.lead_status, r.last_disposition].some((v) =>
                    (v ?? "").toLowerCase().includes(q),
                )) &&
            (!roles || roles.includes((r.holder_role ?? "").toLowerCase())) &&
            (!f.status || r.lead_status === f.status) &&
            (!interest || (r.interest_level ?? "").toLowerCase() === interest) &&
            (!f.minDays || r.days_idle >= f.minDays),
    );
}

/** The filters from a URL (the page's state and the CSV link share these keys). */
export function needsAttentionFiltersFrom(p: URLSearchParams): NeedsAttentionFilters {
    const min = Number(p.get("min_days"));
    return {
        q: p.get("q"),
        role: p.get("role"),
        status: p.get("status"),
        interest: p.get("interest"),
        minDays: Number.isFinite(min) && min > 0 ? min : null,
    };
}
