// 24 Nov (CRM items 5 + 7) — the Team pages' filters. CLIENT-SAFE and pure:
// the pages build their URLs with it, the APIs read them back with it.

export const VISIT_KINDS = ["scheduled", "completed"] as const;
export type VisitKind = (typeof VISIT_KINDS)[number];

export const VISIT_KIND_LABELS: Record<VisitKind, string> = {
    scheduled: "Scheduled visits",
    completed: "Completed visits",
};

export type TeamScope = {
    /** Oversight role: everyone is in scope. */
    all: boolean;
    /** Owner / rep ids in scope (the viewer + direct reports, or everyone). */
    ownerIds: string[];
    people: Array<{ id: string; name: string }>;
};

export type TeamFilters = {
    member: string | null;
    city: string | null;
    businessType: string | null;
    /** 24 Nov tree: one Segment (src/lib/leads/segments.ts). */
    segment: string | null;
    status: string | null;
    q: string | null;
    /** YYYY-MM-DD (IST), inclusive. */
    from: string | null;
    to: string | null;
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Longest range a visits list may span. */
export const MAX_RANGE_DAYS = 366;

const clean = (v: string | null | undefined): string | null => {
    const s = (v ?? "").trim();
    return s ? s.slice(0, 120) : null;
};
const day = (v: string | null | undefined): string | null => {
    const s = clean(v);
    return s && DAY_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? s : null;
};

export function addDays(d: string, n: number): string {
    const x = new Date(`${d}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
}

/** Today in IST, YYYY-MM-DD. */
export function istToday(now = new Date()): string {
    return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/** Reads the filters from a URL query. */
export function teamFiltersFromParams(sp: URLSearchParams): Partial<TeamFilters> {
    return {
        member: clean(sp.get("member")),
        city: clean(sp.get("city")),
        businessType: clean(sp.get("business_type")),
        segment: clean(sp.get("segment")),
        status: clean(sp.get("status")),
        q: clean(sp.get("q")),
        from: day(sp.get("from")),
        to: day(sp.get("to")),
    };
}

/**
 * The filters a query actually runs with: a member outside the scope is
 * dropped (whole team). With `defaultRange` (the visit lists) the range
 * defaults to the last 30 days; either way it is put in order and capped at
 * MAX_RANGE_DAYS. Without it a missing end stays open.
 */
export function resolveTeamFilters(
    scope: Pick<TeamScope, "ownerIds">,
    raw: Partial<TeamFilters>,
    opts: { defaultRange?: boolean; now?: Date } = {},
): TeamFilters {
    const member = raw.member && scope.ownerIds.includes(raw.member) ? raw.member : null;
    let from = day(raw.from);
    let to = day(raw.to);
    const base = { member, city: clean(raw.city), businessType: clean(raw.businessType), segment: clean(raw.segment), status: clean(raw.status), q: clean(raw.q) };
    if (!opts.defaultRange) {
        if (from && to && from > to) [from, to] = [to, from];
        return { ...base, from, to };
    }
    const today = istToday(opts.now);
    if (!to) to = from ? addDays(from, 30) : today;
    if (!from) from = addDays(to, -30);
    if (from > to) [from, to] = [to, from];
    if (addDays(from, MAX_RANGE_DAYS) < to) from = addDays(to, -MAX_RANGE_DAYS);
    return { ...base, from, to };
}

export function isVisitKind(v: unknown): v is VisitKind {
    return typeof v === "string" && (VISIT_KINDS as readonly string[]).includes(v);
}
