// Every AI call attempt for one dealer lead, oldest first — the timeline behind
// the campaign drawer's Attempts tab and the lead page's AI Call History tab.
//
// Two sources:
//   campaign attempts  one dialer_campaign_leads row per attempt; recall
//                      campaigns re-enrol the same lead_id, so ordering every
//                      row by campaign start gives the full journey.
//   one-off calls      the Bolna / ElevenLabs buttons on the leads list dial a
//                      single lead with no campaign, so they exist only in
//                      ai_call_logs. Without them a lead that was called showed
//                      "No AI calls yet" (includeOneOff).
//
// A one-off call is an ai_call_logs row for this lead whose call_id is not on
// any of its campaign attempts. Matched by lead id OR phone last-10-digits, the
// same rule /leads/[id] uses: webhook finalizers attribute by phone, so a log
// row's lead_id can differ.

import { and, asc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { aiCallLogs, dealerLeads, dialerCampaignLeads, dialerCampaigns } from "@/lib/db/schema";
import { INTENT_THRESHOLDS } from "@/lib/ai/scoring";

// Intent score at/above which the dialer considers a lead "qualified" — the
// first attempt to reach it is treated as the converting attempt.
const QUALIFIED_INTENT = INTENT_THRESHOLDS.QUALIFIED;

const PROVIDER_LABEL: Record<string, string> = {
    bolna: "Bolna",
    elevenlabs: "ElevenLabs",
};

export type LeadCallAttempt = {
    attempt: number;
    /** null for a one-off call, which belongs to no campaign. */
    campaignId: string | null;
    campaignName: string | null;
    isRecall: boolean;
    status: string;
    callOutcome: string | null;
    intentScore: number | null;
    startedAt: string | null;
    completedAt: string | null;
    converted: boolean;
    isCurrent: boolean;
    callId: string | null;
    recordingUrl: string | null;
};

function toIso(v: Date | string | null | undefined): string | null {
    if (v == null) return null;
    return v instanceof Date ? v.toISOString() : String(v);
}

// Stored URL when present; else the self-healing proxy (re-hosts + backfills
// ElevenLabs audio on first hit, 302s to Bolna's URL); else null — an attempt
// with no call id simply has no recording.
function recordingFor(callId: string | null, stored: string | null): string | null {
    if (stored) return stored;
    return callId ? `/api/ai-dialer/recording/${encodeURIComponent(callId)}` : null;
}

export async function loadLeadCallAttempts(opts: {
    leadId: string;
    /** Marks that campaign's attempts "This campaign" (the campaign drawer). */
    currentCampaignId?: string | null;
    /** Add calls placed outside any campaign (the lead page). */
    includeOneOff?: boolean;
}): Promise<{ attempts: LeadCallAttempt[]; convertedOnAttempt: number | null }> {
    const { leadId, currentCampaignId = null, includeOneOff = false } = opts;

    const attemptRows = await db
        .select({
            campaignId: dialerCampaignLeads.campaign_id,
            campaignName: dialerCampaigns.name,
            regionFilter: dialerCampaigns.region_filter,
            campaignStartedAt: dialerCampaigns.started_at,
            status: dialerCampaignLeads.status,
            callOutcome: dialerCampaignLeads.call_outcome,
            intentScore: dialerCampaignLeads.intent_score,
            startedAt: dialerCampaignLeads.started_at,
            completedAt: dialerCampaignLeads.completed_at,
            bolnaCallId: dialerCampaignLeads.bolna_call_id,
        })
        .from(dialerCampaignLeads)
        .leftJoin(dialerCampaigns, eq(dialerCampaigns.id, dialerCampaignLeads.campaign_id))
        .where(eq(dialerCampaignLeads.lead_id, leadId))
        .orderBy(asc(dialerCampaigns.started_at), asc(dialerCampaignLeads.created_at));

    // Per-attempt recording: each attempt's bolna_call_id (the provider call id
    // for BOTH Bolna and ElevenLabs — the column doubles for both, see
    // elevenlabs/webhookHandler.ts) maps 1:1 to ai_call_logs.call_id. Resolved in
    // one extra query rather than a join, which could duplicate attempt rows.
    const callIds = attemptRows.map((a) => a.bolnaCallId).filter((c): c is string => !!c);
    const recordingByCall = new Map<string, string | null>();
    if (callIds.length > 0) {
        const recRows = await db
            .select({ callId: aiCallLogs.call_id, recordingUrl: aiCallLogs.recording_url })
            .from(aiCallLogs)
            .where(inArray(aiCallLogs.call_id, callIds));
        for (const r of recRows) recordingByCall.set(r.callId, r.recordingUrl);
    }

    const rows: Omit<LeadCallAttempt, "attempt" | "converted">[] = attemptRows.map((a) => {
        const isRecall =
            a.regionFilter && typeof a.regionFilter === "object"
                ? (a.regionFilter as { recall?: unknown }).recall === true
                : false;
        const callId = a.bolnaCallId ?? null;
        return {
            campaignId: a.campaignId,
            campaignName: a.campaignName ?? null,
            isRecall,
            status: a.status,
            callOutcome: a.callOutcome,
            intentScore: a.intentScore ?? null,
            startedAt: toIso(a.startedAt ?? a.campaignStartedAt),
            completedAt: toIso(a.completedAt),
            isCurrent: currentCampaignId != null && a.campaignId === currentCampaignId,
            callId,
            recordingUrl: recordingFor(callId, callId ? recordingByCall.get(callId) ?? null : null),
        };
    });

    if (includeOneOff) {
        const [lead] = await db
            .select({ phone: dealerLeads.phone })
            .from(dealerLeads)
            .where(eq(dealerLeads.id, leadId))
            .limit(1);
        const phoneLast10 = (lead?.phone ?? "").replace(/\D/g, "").slice(-10);
        const oneOff = await db
            .select({
                callId: aiCallLogs.call_id,
                provider: aiCallLogs.provider,
                status: aiCallLogs.status,
                intentScore: aiCallLogs.intent_score,
                nextAction: aiCallLogs.next_action,
                startedAt: aiCallLogs.started_at,
                endedAt: aiCallLogs.ended_at,
                createdAt: aiCallLogs.created_at,
                recordingUrl: aiCallLogs.recording_url,
            })
            .from(aiCallLogs)
            .where(
                and(
                    or(
                        eq(aiCallLogs.lead_id, leadId),
                        phoneLast10.length === 10
                            ? sql`right(regexp_replace(${aiCallLogs.phone_number}, '[^0-9]', '', 'g'), 10) = ${phoneLast10}`
                            : sql`false`,
                    ),
                    callIds.length > 0 ? notInArray(aiCallLogs.call_id, callIds) : undefined,
                ),
            );
        for (const c of oneOff) {
            const provider = PROVIDER_LABEL[(c.provider ?? "").toLowerCase()] ?? c.provider;
            rows.push({
                campaignId: null,
                campaignName: provider ? `Single call · ${provider}` : "Single call",
                isRecall: false,
                status: c.status ?? "completed",
                callOutcome: c.nextAction ?? null,
                intentScore: c.intentScore ?? null,
                startedAt: toIso(c.startedAt ?? c.createdAt),
                completedAt: toIso(c.endedAt),
                isCurrent: false,
                callId: c.callId,
                recordingUrl: recordingFor(c.callId, c.recordingUrl),
            });
        }
        // Interleave by when each call happened; a row with no time goes last.
        rows.sort((a, b) => {
            const ta = a.startedAt ? Date.parse(a.startedAt) : Number.POSITIVE_INFINITY;
            const tb = b.startedAt ? Date.parse(b.startedAt) : Number.POSITIVE_INFINITY;
            return ta - tb;
        });
    }

    const attempts: LeadCallAttempt[] = rows.map((r, i) => ({
        ...r,
        attempt: i + 1,
        converted: r.intentScore != null && r.intentScore >= QUALIFIED_INTENT,
    }));
    const convertedOnAttempt = attempts.find((a) => a.converted)?.attempt ?? null;
    return { attempts, convertedOnAttempt };
}
