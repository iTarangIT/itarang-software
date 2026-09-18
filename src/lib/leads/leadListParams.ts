/**
 * Parse the /leads list filters out of a query string — ONE reader for every
 * route that must agree with the screen about which leads matched.
 *
 * Extracted (B11) from GET /api/dealer-leads/export, which carried this block
 * inline with the comment "parsed EXACTLY as GET /api/dealer-leads parses it".
 * The full-leads Excel export needs the same filters, and a third hand-written
 * copy is how an export starts quietly disagreeing with the list it claims to
 * be of. Both routes now call this.
 *
 * Owner / ASM / assigned-date filters ride on `caps.canSeeOwnerAsm`: a role
 * that cannot see who owns a lead on screen cannot filter by it here either
 * and learn the answer by inference.
 */

import type { LeadsCapabilities } from "@/lib/leads/access";
import { isIntentBucket, normalizeScoreRange, parseScoreBound } from "@/lib/leads/intentBucket";
import { isConnectStatus, isDispositionBucket } from "@/lib/leads/dispositions";
import type { LeadListFilters } from "@/lib/leads/leadListQuery";
import { IDLE_RANGES, isIdleRangeKey } from "@/lib/leads/idle";
import { neodoveTablesPresent } from "@/lib/leads/leadCampaign";
import { isBusinessTypeFilter } from "@/lib/leads/businessType";

export async function parseLeadListFilters(
    searchParams: URLSearchParams,
    caps: LeadsCapabilities,
): Promise<LeadListFilters> {
    const intentParam = searchParams.get("intent");
    const connectStatusParam = searchParams.get("connect_status");
    const bucketParam = searchParams.get("disposition_bucket");
    const idleParam = searchParams.get("idle");
    const idleRange = isIdleRangeKey(idleParam) ? IDLE_RANGES[idleParam] : null;
    const campaignParam = searchParams.get("campaign")?.trim() || null;
    const scoreRange = normalizeScoreRange(
        parseScoreBound(searchParams.get("score_min")),
        parseScoreBound(searchParams.get("score_max")),
    );
    const hasNeodoveTables = campaignParam ? await neodoveTablesPresent() : false;

    return {
        status: searchParams.get("status") || null,
        intent: isIntentBucket(intentParam) ? intentParam : null,
        scoreMin: scoreRange.min,
        scoreMax: scoreRange.max,
        source: searchParams.get("source") || null,
        neodoveOnly: searchParams.get("neodove") === "1",
        idleMinDays: idleRange?.min ?? null,
        idleMaxDays: idleRange?.max ?? null,
        idleNeverTouched: searchParams.get("idle") === "never",
        campaign: campaignParam,
        hasNeodoveTables,
        state: searchParams.get("state")?.trim() || null,
        city: searchParams.get("city")?.trim() || null,
        search: searchParams.get("search")?.trim() || null,
        from: searchParams.get("from")?.trim() || null,
        to: searchParams.get("to")?.trim() || null,
        connectStatus: isConnectStatus(connectStatusParam) ? connectStatusParam : null,
        dispositionBucket: isDispositionBucket(bucketParam) ? bucketParam : null,
        aiCalled: ["connected", "attempted", "never"].includes(searchParams.get("ai_called") ?? "")
            ? searchParams.get("ai_called")
            : null,
        aiBand: ["Qualified", "Warm", "Cold", "Disqualified"].includes(searchParams.get("ai_band") ?? "")
            ? searchParams.get("ai_band")
            : null,
        signalsMin: (() => {
            const n = Number(searchParams.get("signals_min"));
            return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
        })(),
        callback: searchParams.get("callback") === "1",
        disposition: searchParams.get("disposition")?.trim() || null,
        businessType: isBusinessTypeFilter(searchParams.get("business_type"))
            ? searchParams.get("business_type")
            : null,
        ownerId: caps.canSeeOwnerAsm ? searchParams.get("owner_id") || null : null,
        asmId: caps.canSeeOwnerAsm ? searchParams.get("asm_id") || null : null,
        assignedFrom: caps.canSeeOwnerAsm ? searchParams.get("assigned_from")?.trim() || null : null,
        assignedTo: caps.canSeeOwnerAsm ? searchParams.get("assigned_to")?.trim() || null : null,
    };
}
