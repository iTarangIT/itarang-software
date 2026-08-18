// The leaf SQL predicates behind LeadStateFilters.
//
// Shared between src/lib/ai-dialer/audience.ts (the campaign builder) and
// src/lib/leads/leadListQuery.ts (the /leads list), which have different base
// clauses, different city semantics and different hot/warm/cold scales — see
// the header of leadStateFilters.ts for why the two WHERE assemblers stay
// separate while these fragments are shared.
//
// Every fragment assumes dealer_leads is aliased `dl`, matching AI_DIALABLE_SQL
// and buildWhere. No `db` import: these are composed by the caller.

import { sql, type SQL } from "drizzle-orm";
import {
    AI_ATTEMPTED_SQL,
    AI_CONNECTED_SQL,
} from "@/lib/ai-dialer/exclusionFilter";
import type { AiCallState, LeadStateFilters } from "@/lib/leads/leadStateFilters";

/**
 * "Never called by AI" / "AI called but never connected".
 *
 * Returns null for "any", so the caller can skip appending anything at all.
 */
export function aiCallStatePredicate(state: AiCallState): SQL | null {
    if (state === "never_called") {
        return sql`NOT ${AI_ATTEMPTED_SQL}`;
    }
    if (state === "attempted_not_connected") {
        // Both halves stated explicitly even though, inside the campaign
        // builder, the second is already guaranteed by the AI-connected hard
        // block. The same fragment is reused by the /leads list, where the block
        // does NOT apply — and a filter that silently depends on a global
        // exclusion is one refactor away from being wrong.
        return sql`(${AI_ATTEMPTED_SQL} AND NOT ${AI_CONNECTED_SQL})`;
    }
    return null;
}

/** At least N AI call attempts, connected or not. */
export function aiAttemptsMinPredicate(min: number): SQL {
    return sql`(
        SELECT COUNT(*) FROM ai_call_logs acl WHERE acl.lead_id = dl.id
    ) >= ${min}`;
}

/**
 * The E-236 L1/L2/L3 predicates — zero to three fragments.
 *
 * ⚠ Emitted ONLY for the levels that are set. These columns are NOT mirrored in
 * schema.ts (see the header in src/lib/db/schema.ts), so naming one on a
 * database that has not applied E-236 is a hard "column does not exist". Keeping
 * them behind their own filter is what lets such a database keep serving
 * previews and lists to everyone who does not use the disposition filter — the
 * same discipline leadListQuery.ts:273-285 already follows.
 *
 * The three levels narrow each other in the UI but are ANDed independently
 * here, so a hand-built request carrying only a bucket is valid on its own.
 */
export function dispositionPredicates(f: LeadStateFilters): SQL[] {
    const out: SQL[] = [];
    if (f.connectStatus) {
        out.push(sql`dl.last_connect_status = ${f.connectStatus}`);
    }
    if (f.dispositionBucket) {
        out.push(sql`dl.last_disposition_bucket = ${f.dispositionBucket}`);
    }
    if (f.disposition) {
        out.push(sql`dl.last_disposition = ${f.disposition}`);
    }
    return out;
}

/** Everything in LeadStateFilters, as a flat list of ANDable fragments. */
export function leadStatePredicates(
    f: LeadStateFilters | null | undefined,
): SQL[] {
    if (!f) return [];
    const out: SQL[] = [];

    const state = f.aiCallState ? aiCallStatePredicate(f.aiCallState) : null;
    if (state) out.push(state);

    if (typeof f.aiAttemptsMin === "number" && f.aiAttemptsMin > 0) {
        out.push(aiAttemptsMinPredicate(f.aiAttemptsMin));
    }

    out.push(...dispositionPredicates(f));
    return out;
}
