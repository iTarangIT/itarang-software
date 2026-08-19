// The lead-state filter vocabulary, shared by the campaign builder and the
// /leads list so the two can never drift on the value strings.
//
// WHY A SHARED VOCABULARY BUT NOT A SHARED QUERY BUILDER. The two consumers ask
// the same QUESTIONS ("never called by AI") through different machinery:
//
//   src/lib/leads/leadListQuery.ts buildWhere()   src/lib/ai-dialer/audience.ts
//     base: dl.is_active IS NOT FALSE               base: phone IS NOT NULL
//                                                         AND AI_DIALABLE_SQL
//     city: dl.city ILIKE '%x%'                     city: canonical city_bucket
//                                                         via city_aliases
//     hot/warm/cold: INTENT_BUCKETS 75/31           hot/warm/cold: bucketOf 75/45
//     output: ids capped at 5000, touchpoint order  output: everything, score order
//
// Those differences are deliberate — intentBucket.ts's header explicitly says
// the two hot/warm/cold scales must not be unified, because moving audience.ts's
// floor changes which leads a "warm" campaign actually dials. So the leaf
// predicates are shared (leadStateSql.ts) and the two WHERE assemblers stay
// apart.
//
// No `db` import, no React: this module is imported by client components.

export const AI_CALL_STATES = [
    "any",
    "never_called",
    "attempted_not_connected",
] as const;
export type AiCallState = (typeof AI_CALL_STATES)[number];

export const AI_CALL_STATE_LABEL: Record<AiCallState, string> = {
    any: "Any",
    never_called: "Never called by AI",
    attempted_not_connected: "AI called, never connected",
};

export const AI_CALL_STATE_HINT: Record<AiCallState, string> = {
    any: "Every dialable lead in the selection.",
    never_called: "No AI call has ever been placed to this dealer.",
    attempted_not_connected:
        "The AI tried and never got through — no answer, busy, switched off.",
};

export function isAiCallState(v: unknown): v is AiCallState {
    return (AI_CALL_STATES as readonly unknown[]).includes(v);
}

/**
 * The filters both surfaces understand.
 *
 * `connectStatus` / `dispositionBucket` / `disposition` are the E-236 L1/L2/L3
 * columns. They are migration-gated and NOT mirrored in schema.ts, so every
 * consumer must emit their predicates ONLY when the filter is set — the rule
 * leadListQuery.ts already follows, which is what lets a database without E-236
 * keep serving the list to everyone who does not use them.
 */
export type LeadStateFilters = {
    aiCallState?: AiCallState;
    /**
     * Minimum AI call attempts. Pairs with `attempted_not_connected`: "tried
     * once" is worth a retry, "tried six times" is a dead number, and without
     * this the filter cannot tell them apart.
     */
    aiAttemptsMin?: number | null;
    connectStatus?: string | null;
    dispositionBucket?: string | null;
    disposition?: string | null;
};

export const EMPTY_LEAD_STATE_FILTERS: LeadStateFilters = {
    aiCallState: "any",
    aiAttemptsMin: null,
    connectStatus: null,
    dispositionBucket: null,
    disposition: null,
};

/** Is any of this actually narrowing anything? Drives the "N filters" badge. */
export function hasLeadStateFilter(f: LeadStateFilters | null | undefined): boolean {
    if (!f) return false;
    return Boolean(
        (f.aiCallState && f.aiCallState !== "any") ||
            (typeof f.aiAttemptsMin === "number" && f.aiAttemptsMin > 0) ||
            f.connectStatus ||
            f.dispositionBucket ||
            f.disposition,
    );
}

/**
 * A compact human summary, at most one clause, for the campaign history chip.
 *
 * First non-empty wins rather than joining everything, so the one-liner in the
 * Campaigns table cannot grow unbounded as filters are added.
 */
export function summarizeLeadStateFilters(
    f: LeadStateFilters | null | undefined,
): string | null {
    if (!hasLeadStateFilter(f)) return null;
    const s = f as LeadStateFilters;
    if (s.disposition) return s.disposition;
    if (s.dispositionBucket) return s.dispositionBucket;
    if (s.aiCallState === "never_called") return "Never called";
    if (s.aiCallState === "attempted_not_connected") {
        return typeof s.aiAttemptsMin === "number" && s.aiAttemptsMin > 1
            ? `No connect ×${s.aiAttemptsMin}+`
            : "No connect";
    }
    if (s.connectStatus === "connected") return "Connected";
    if (s.connectStatus === "not_connected") return "Not connected";
    if (typeof s.aiAttemptsMin === "number" && s.aiAttemptsMin > 0) {
        return `${s.aiAttemptsMin}+ attempts`;
    }
    return null;
}

/** The long form, for the campaign detail header. Joins every set clause. */
export function describeLeadStateFilters(
    f: LeadStateFilters | null | undefined,
): string | null {
    if (!hasLeadStateFilter(f)) return null;
    const s = f as LeadStateFilters;
    const parts: string[] = [];
    if (s.aiCallState && s.aiCallState !== "any") {
        parts.push(AI_CALL_STATE_LABEL[s.aiCallState]);
    }
    if (typeof s.aiAttemptsMin === "number" && s.aiAttemptsMin > 0) {
        parts.push(`at least ${s.aiAttemptsMin} attempt${s.aiAttemptsMin === 1 ? "" : "s"}`);
    }
    if (s.connectStatus) {
        parts.push(s.connectStatus === "connected" ? "Connected" : "Not connected");
    }
    if (s.dispositionBucket) parts.push(`bucket ${s.dispositionBucket}`);
    if (s.disposition) parts.push(`disposition "${s.disposition}"`);
    return parts.length ? parts.join("; ") : null;
}

/**
 * Take only known keys off an untrusted blob.
 *
 * Used on both the wire (a POSTed campaign selection) and on read (a
 * region_filter jsonb written by an older build). Anything unrecognised is
 * dropped rather than passed through to SQL.
 */
export function sanitizeLeadStateFilters(raw: unknown): LeadStateFilters {
    if (!raw || typeof raw !== "object") return {};
    const r = raw as Record<string, unknown>;
    const out: LeadStateFilters = {};

    if (isAiCallState(r.aiCallState)) out.aiCallState = r.aiCallState;

    const min = Number(r.aiAttemptsMin);
    if (Number.isFinite(min) && min > 0) out.aiAttemptsMin = Math.floor(min);

    if (r.connectStatus === "connected" || r.connectStatus === "not_connected") {
        out.connectStatus = r.connectStatus;
    }
    if (typeof r.dispositionBucket === "string" && r.dispositionBucket.trim()) {
        out.dispositionBucket = r.dispositionBucket.trim();
    }
    // NOT validated against the sheet, deliberately: a value NeoDove sent
    // outside it is legitimately filterable, and leadListQuery's facets query
    // reports what is actually in the data. Parameterised at the SQL layer.
    if (typeof r.disposition === "string" && r.disposition.trim()) {
        out.disposition = r.disposition.trim();
    }
    return out;
}
