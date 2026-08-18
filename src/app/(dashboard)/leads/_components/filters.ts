// Filter state for the merged Leads tab. Kept in its own module so the page,
// the filter bar and the stat cards all share one shape and one set of
// query-param names.

import {
    isConnectStatus,
    isDispositionBucket,
    type ConnectStatus,
    type DispositionBucket,
} from "@/lib/leads/dispositions";
import type { IntentBucket } from "@/lib/leads/intentBucket";
import { isIdleRangeKey } from "@/lib/leads/idle";

export type LeadFilters = {
    search: string;
    /** lead_status pipeline stage, or UNASSIGNED_FILTER. Labelled "Qualification". */
    status: string;
    intent: "" | IntentBucket;
    /**
     * Explicit intent-score bounds, held as strings because they are bound to
     * number <input>s — "" is a cleared box, which `0` would not distinguish
     * from a real lower bound of zero.
     *
     * Mutually exclusive with `intent` in the UI: a bucket IS a score range, so
     * holding both is either redundant or self-contradicting.
     */
    scoreMin: string;
    scoreMax: string;
    ownerId: string;
    asmId: string;
    source: string;
    /**
     * "1" = only leads handed to the NeoDove calling team.
     *
     * Separate from `source` on purpose. `dealer_leads.source` says where a lead
     * came FROM and is only ever "neodove" for leads NeoDove itself created, so
     * filtering on it would hide every scraped or uploaded lead we later pushed
     * — which is the bulk of what is actually in NeoDove. See
     * NEODOVE_LINKED_SYNC_STATUSES.
     */
    neodove: "" | "1";
    /** Idle band key — see IDLE_RANGES. "" = any. */
    idle: string;
    /** Campaign id from either system, or CAMPAIGN_NONE. "" = any. */
    campaign: string;
    state: string;
    city: string;
    /** created_at range, YYYY-MM-DD. */
    from: string;
    to: string;
    // ── Call disposition, L1 → L2 → L3 (E-236) ───────────────────────────
    // Three fields rather than one because each level is independently useful:
    // "everything Not Connected" and "everything we lost" are questions in their
    // own right, not just a path to picking one disposition. They narrow each
    // other in the UI but are ANDed independently in SQL, so a bookmarked URL
    // with only `disposition_bucket` set is valid on its own.
    /** L1 — connected | not_connected. */
    connectStatus: "" | ConnectStatus;
    /** L2 — Cold | Warm | Hot | Converted | Lost. Meaningless when L1 is not_connected. */
    dispositionBucket: "" | DispositionBucket;
    /** L3 — the disposition itself. Free text: values outside the sheet are filterable too. */
    disposition: string;
    // ── AI call state + signals ───────────────────────────────────────────
    /** "" | connected | attempted | never. Actually CALLED, not merely queued. */
    aiCalled: string;
    /** "" | Qualified | Warm | Cold | Disqualified. */
    aiBand: string;
    /** "" | "1".."5" — at least N of the five info signals disclosed. */
    signalsMin: string;
    /** "1" = the dealer asked to be called back, per either system. */
    callback: "" | "1";
};

export const EMPTY_FILTERS: LeadFilters = {
    search: "",
    status: "",
    intent: "",
    scoreMin: "",
    scoreMax: "",
    ownerId: "",
    asmId: "",
    source: "",
    neodove: "",
    idle: "",
    campaign: "",
    state: "",
    city: "",
    from: "",
    to: "",
    connectStatus: "",
    dispositionBucket: "",
    disposition: "",
    aiCalled: "",
    aiBand: "",
    signalsMin: "",
    callback: "",
};

// Filters tucked behind the "More filters" disclosure. Counted for the badge so
// a filter that is doing work can never be invisible.
// `neodove` is NOT here: it lives in the primary row beside the search box, for
// the same reason it does on the Inside Sales queue — a filter that silently
// removes most of the list should not be one disclosure away from invisible.
export const SECONDARY_KEYS: (keyof LeadFilters)[] = [
    "asmId",
    "source",
    "idle",
    "campaign",
    "state",
    "city",
    "connectStatus",
    "dispositionBucket",
    "disposition",
    "aiCalled",
    "aiBand",
    "signalsMin",
];
// `callback` is deliberately NOT secondary. Same argument as `neodove` above: it
// is an ACTION filter — "who asked us to call back" — not a refinement, and the
// leads it surfaces need a human today. One disclosure away from invisible is
// the wrong place for it.

export function isFilterSet(f: LeadFilters, key: keyof LeadFilters): boolean {
    return f[key] !== "";
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
    if (f.scoreMin) p.set("score_min", f.scoreMin);
    if (f.scoreMax) p.set("score_max", f.scoreMax);
    if (f.ownerId) p.set("owner_id", f.ownerId);
    if (f.asmId) p.set("asm_id", f.asmId);
    if (f.source) p.set("source", f.source);
    if (f.neodove) p.set("neodove", f.neodove);
    if (f.idle) p.set("idle", f.idle);
    if (f.campaign) p.set("campaign", f.campaign);
    if (f.state) p.set("state", f.state);
    if (f.city) p.set("city", f.city);
    if (f.from) p.set("from", f.from);
    if (f.to) p.set("to", f.to);
    if (f.connectStatus) p.set("connect_status", f.connectStatus);
    if (f.dispositionBucket) p.set("disposition_bucket", f.dispositionBucket);
    if (f.disposition) p.set("disposition", f.disposition);
    if (f.aiCalled) p.set("ai_called", f.aiCalled);
    if (f.aiBand) p.set("ai_band", f.aiBand);
    if (f.signalsMin) p.set("signals_min", f.signalsMin);
    if (f.callback) p.set("callback", f.callback);
    return p;
}

/** Seed filter state from a URL — used for the /admin/leads-info redirect. */
export function fromSearchParams(sp: URLSearchParams): LeadFilters {
    const intent = sp.get("intent");
    const connectStatus = sp.get("connect_status");
    const bucket = sp.get("disposition_bucket");
    return {
        ...EMPTY_FILTERS,
        search: sp.get("search") ?? "",
        status: sp.get("status") ?? "",
        intent:
            intent === "hot" || intent === "warm" || intent === "cold" ? intent : "",
        scoreMin: sp.get("score_min") ?? "",
        scoreMax: sp.get("score_max") ?? "",
        ownerId: sp.get("owner_id") ?? "",
        asmId: sp.get("asm_id") ?? "",
        source: sp.get("source") ?? "",
        neodove: sp.get("neodove") === "1" ? "1" : "",
        // Validated against the closed band vocabulary, like connectStatus: an
        // unrecognised value would seed a <select> with no matching option and
        // render as a blank selection that silently filters nothing.
        idle: isIdleRangeKey(sp.get("idle")) ? (sp.get("idle") as string) : "",
        // NOT validated — campaign ids are opaque and the facet list is data,
        // not a fixed vocabulary. An unknown id matches nothing, which is the
        // truthful answer for a campaign this database does not have.
        campaign: sp.get("campaign") ?? "",
        state: sp.get("state") ?? "",
        city: sp.get("city") ?? "",
        from: sp.get("from") ?? "",
        to: sp.get("to") ?? "",
        // Validated, not trusted: these seed a <select> whose value must be one
        // of its options, and an unrecognised one would render as a blank
        // selection that silently filters nothing. `disposition` is deliberately
        // NOT validated against the sheet — a value NeoDove sent outside it is
        // legitimately filterable, and the API validates it against what is
        // actually in the data.
        connectStatus: isConnectStatus(connectStatus) ? connectStatus : "",
        dispositionBucket: isDispositionBucket(bucket) ? bucket : "",
        disposition: sp.get("disposition") ?? "",
        // Validated against their closed vocabularies: an unrecognised value
        // would seed a <select> with no matching option and render as a blank
        // selection that silently filters nothing.
        aiCalled: ["connected", "attempted", "never"].includes(sp.get("ai_called") ?? "")
            ? (sp.get("ai_called") as string)
            : "",
        aiBand: ["Qualified", "Warm", "Cold", "Disqualified"].includes(
            sp.get("ai_band") ?? "",
        )
            ? (sp.get("ai_band") as string)
            : "",
        signalsMin: ["1", "2", "3", "4", "5"].includes(sp.get("signals_min") ?? "")
            ? (sp.get("signals_min") as string)
            : "",
        callback: sp.get("callback") === "1" ? "1" : "",
    };
}
