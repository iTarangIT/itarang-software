// AI dialer review (23 Oct 2026, points 1–6, 8, 10) — what happens after a
// call, beyond scoring. Both finalizers (Bolna, ElevenLabs) call this in every
// branch, so the two providers cannot drift:
//
//   preparePostCall()  BEFORE the campaign row is written: decides the outcome
//                      category (callCategory.ts), who owns any callback and
//                      when it is due, and the call_outcome that makes a call
//                      cut off mid-conversation retryable (retryPolicy.ts).
//   applyPostCall()    AFTER: records the category (ai_call_outcomes), settles
//                      an AI callback re-dial this call was placed for, opens
//                      or refreshes the lead's callback (lead_callbacks), and
//                      hands a sales callback to the CRM.
//
// THE CRM HAND-OFF uses the existing workflow and statuses only (point 4):
//   * Sales-ready event, reason 'ai_callback' → the lead appears in "Ready leads
//     with no owner" (/admin/ready-to-assign), the CEO card, the nav count and
//     the daily email, and its ready_assign clock starts. lead_status stays as
//     it is; the existing assignment flow (assignLeadOwner) lifts it into the
//     assignee's queue (Assigned_Not_Contacted / Transferred_to_ASM).
//   * next_follow_up_at = the callback's due time → once someone owns the
//     lead it sits in their existing Follow-ups tab.
//   * A bell for the admins (and the owner, when there is one).
// Point 10 (auto-qualify): the band rule already lifts a callback to Warm
// (computeBand 2.1.0); a dealer asking for a manager is made Hot here.
//
// Never throws: a failure here loses the extra record, never the call.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import type { CallEndClassification } from "./campaignLeadStatus";
import {
    CALL_CATEGORY_LABELS,
    CALL_CATEGORY_VERSION,
    callbackDueAt,
    categorizeCall,
    type CategoryAnalysis,
    type CategoryResult,
} from "./callCategory";
import { clampIntoWindow, DISCONNECTED_OUTCOME } from "./retryPolicy";
import { defaultRetryWindow } from "@/lib/queue/campaignTracker";
import { aiInterestLevelSql } from "@/lib/ai/storage/aiInterest";
import { markSalesReady } from "@/lib/leads/salesReady";
import { notifyRoles, notifyUser } from "@/lib/notifications/notify";
import { ADMIN_AUDIENCE_ROLES } from "@/lib/notifications/emit";
import { leadHrefFor } from "@/lib/leads/newOwnerNotice";
import {
    closeCallback,
    findCallbackByCallId,
    recordCallOutcome,
    reopenCallback,
    upsertOpenCallback,
} from "@/lib/ai/storage/callOutcomeStore";

export const CALLBACK_NOTIFICATION_TYPE = "lead.callback_requested";

/** AI callbacks unreached this many times are given up on. */
export const MAX_AI_CALLBACK_ATTEMPTS = 3;
/** An unreached AI callback is tried again this much later. */
const AI_CALLBACK_REDIAL_GAP_MS = 2 * 60 * 60 * 1000;

type Provider = "bolna" | "elevenlabs";

/** The analysis fields this flow reads — AnalysisOk satisfies it. */
export type PostCallAnalysis = CategoryAnalysis & {
    callback_time: string | null;
    intent_score: number;
    signals: CategoryAnalysis["signals"] & { callback_when?: string };
};

export type PostCallPlan = {
    cat: CategoryResult;
    callbackDue: Date | null;
};

function rows<T>(r: unknown): T[] {
    return ((r as { rows?: T[] }).rows ?? (r as T[])) || [];
}

/**
 * Decide the category and the callback before anything is written. Async only
 * to read the calling window and whether the lead is already a person's.
 */
export async function preparePostCall(input: {
    callEnd: CallEndClassification;
    callOutcome?: string | null;
    analysis: PostCallAnalysis | null;
    analysisFailed?: boolean;
    transcript: string | null;
    leadId: string | null;
    /** When the call happened — defaults to now (a live call). */
    now?: Date;
}): Promise<PostCallPlan> {
    const cat = categorizeCall({
        campaignStatus: input.callEnd.status,
        callOutcome: input.callOutcome ?? input.callEnd.outcome ?? null,
        analysis: input.analysis,
        analysisFailed: input.analysisFailed,
    });
    if (!cat.callbackOwner || !input.analysis) return { cat, callbackDue: null };

    try {
        if (input.leadId) {
            const l = rows<{ owned: boolean; won: boolean }>(await db.execute(sql`
                SELECT (current_owner_id IS NOT NULL OR lead_status IS NOT NULL) AS owned,
                       COALESCE(lead_status, '') IN ('Won', 'Converted') AS won
                  FROM dealer_leads WHERE id = ${input.leadId}
            `));
            // Already won business needs no callback record — the category stays.
            if (l[0]?.won) return { cat: { ...cat, callbackOwner: null }, callbackDue: null };
            // A lead a person already owns, or that is in the sales lifecycle, is
            // never re-dialled by the AI: the callback goes to the people instead.
            if (cat.callbackOwner === "ai" && l[0]?.owned) {
                cat.callbackOwner = "sales";
                cat.category = "callback_sales";
            }
        }
        const window = await defaultRetryWindow();
        const callbackDue = callbackDueAt({
            owner: cat.callbackOwner,
            callbackAt: input.analysis.callback_time,
            callbackWhen: input.analysis.signals.callback_when ?? null,
            transcript: input.transcript,
            now: input.now ?? new Date(),
            window,
        });
        return { cat, callbackDue };
    } catch (e) {
        console.warn("[postCallOutcome] callback time not resolved:", e instanceof Error ? e.message : e);
        return { cat, callbackDue: new Date(Date.now() + AI_CALLBACK_REDIAL_GAP_MS) };
    }
}

/** call_outcome for the campaign row: 'disconnected' makes a dropped call retryable. */
export function campaignOutcomeFor(plan: PostCallPlan, fallback: string | null): string | null {
    return plan.cat.retryAsDisconnected ? DISCONNECTED_OUTCOME : fallback;
}

/**
 * The connected-call score (review point 7): every call the dealer spoke on
 * carries a number. Only dropped_empty had none — it is 0 now.
 */
export function connectedScore(plan: PostCallPlan, score: number | null): number | null {
    if (score != null) return score;
    return plan.cat.connected && plan.cat.category !== "needs_review" ? 0 : null;
}

export async function applyPostCall(input: {
    provider: Provider;
    callId: string;
    leadId: string | null;
    plan: PostCallPlan;
    callEnd: CallEndClassification;
    band: string | null;
    intentScore: number | null;
    summary: string | null;
    transcript: string | null;
    requestedText?: string | null;
    campaign: { campaignId: string | null; campaignLeadId?: string | null; retryAt?: Date | null } | null;
}): Promise<void> {
    const { plan, leadId } = input;
    const { cat } = plan;
    try {
        await recordCallOutcome({
            callId: input.callId,
            provider: input.provider,
            leadId,
            campaignId: input.campaign?.campaignId ?? null,
            campaignLeadId: input.campaign?.campaignLeadId ?? null,
            category: cat.category,
            connected: cat.connected,
            campaignStatus: input.callEnd.status,
            band: input.band,
            intentScore: input.intentScore,
            callbackOwner: cat.callbackOwner,
            callbackTopic: cat.callbackTopic,
            callbackDueAt: plan.callbackDue,
            wantsHuman: cat.wantsHuman,
            retryAt: input.campaign?.retryAt ?? null,
            summary: input.summary,
            ruleVersion: CALL_CATEGORY_VERSION,
        });
        if (!leadId) return;

        // ── An AI callback re-dial: settle the callback it was placed for. ──
        const redial = await findCallbackByCallId(input.callId);
        if (redial && !cat.callbackOwner) {
            if (!cat.connected) {
                if (redial.attempts >= MAX_AI_CALLBACK_ATTEMPTS) {
                    await closeCallback(redial.id, "expired", `Not reached after ${redial.attempts} AI callback attempts.`);
                } else {
                    const window = await defaultRetryWindow();
                    await reopenCallback(redial.id, clampIntoWindow(new Date(Date.now() + AI_CALLBACK_REDIAL_GAP_MS), window));
                }
            } else {
                await closeCallback(redial.id, "done", `AI called back — ${CALL_CATEGORY_LABELS[cat.category]}.`);
            }
        }

        // ── A (new or repeated) callback request. ──
        if (!cat.callbackOwner || !plan.callbackDue) return;
        // "Call me later" again, on an AI callback that has used its attempts:
        // people take it from here, or the AI would ring him forever.
        if (redial && cat.callbackOwner === "ai" && redial.attempts >= MAX_AI_CALLBACK_ATTEMPTS) {
            cat.callbackOwner = "sales";
            cat.category = "callback_sales";
        }
        const cb = await upsertOpenCallback({
            leadId,
            sourceCallId: input.callId,
            campaignId: input.campaign?.campaignId ?? null,
            provider: input.provider,
            owner: cat.callbackOwner,
            topic: cat.callbackTopic,
            category: cat.category,
            requestedText: input.requestedText ?? null,
            dueAt: plan.callbackDue,
            summary: input.summary,
            transcriptExcerpt: input.transcript ? input.transcript.slice(-1500) : null,
        });
        const owner = cb?.owner ?? cat.callbackOwner;
        if (owner === "sales") {
            await handOffSalesCallback({
                leadId,
                dueAt: plan.callbackDue,
                cat,
                summary: input.summary,
                notify: cb?.created ?? true,
            });
        }
    } catch (e) {
        console.error("[postCallOutcome] post-call outcome failed:", e instanceof Error ? e.message : e);
    }
}

async function handOffSalesCallback(input: {
    leadId: string;
    dueAt: Date;
    cat: CategoryResult;
    summary: string | null;
    notify: boolean;
}): Promise<void> {
    const { leadId, dueAt, cat } = input;
    const due = dueAt.toISOString();

    await markSalesReady(db, { leadId, reason: "ai_callback", actorId: null });

    // The follow-up date the rep queues already sort by. Moved EARLIER only — a
    // rep's own sooner follow-up is never pushed back by the AI.
    await db
        .update(dealerLeads)
        .set({
            next_follow_up_at: sql`CASE
                WHEN ${dealerLeads.next_follow_up_at} IS NULL
                  OR ${dealerLeads.next_follow_up_at} < now()
                  OR ${dealerLeads.next_follow_up_at} > ${due}::timestamptz
                THEN ${due}::timestamptz
                ELSE ${dealerLeads.next_follow_up_at} END`,
            // Point 10 — asked for a person: Hot (the owner guard still applies).
            ...(cat.wantsHuman ? { interest_level: aiInterestLevelSql("hot") } : {}),
        })
        .where(sql`${dealerLeads.id} = ${leadId}`);

    if (!input.notify) return;
    const lead = rows<{ name: string | null; owner_id: string | null; owner_role: string | null }>(await db.execute(sql`
        SELECT COALESCE(dl.dealer_name, dl.shop_name, dl.phone) AS name,
               dl.current_owner_id AS owner_id, u.role AS owner_role
          FROM dealer_leads dl
          LEFT JOIN users u ON u.id::text = dl.current_owner_id
         WHERE dl.id = ${leadId}
    `))[0];
    const name = lead?.name ?? leadId;
    const when = dueAt.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
    });
    const what = cat.wantsHuman ? "asked to speak to a Sales Manager" : "asked for a callback";
    const topic = cat.callbackTopic && cat.callbackTopic !== "none" ? ` about ${cat.callbackTopic.replace(/_/g, " ")}` : "";
    const message = `${name} ${what}${topic} on an AI call — due ${when}.${input.summary ? ` ${input.summary}` : ""}`;
    const data = { leadId, category: cat.category, dueAt: due, topic: cat.callbackTopic };

    try {
        if (lead?.owner_id) {
            await notifyUser(lead.owner_id, {
                type: CALLBACK_NOTIFICATION_TYPE,
                title: "Callback requested on your lead",
                message,
                data: { ...data, href: leadHrefFor(lead.owner_role, leadId) },
                leadId,
            });
        }
        await notifyRoles(ADMIN_AUDIENCE_ROLES, {
            type: CALLBACK_NOTIFICATION_TYPE,
            title: lead?.owner_id ? "Callback requested (lead has an owner)" : "Callback requested — assign a rep",
            message,
            data: { ...data, href: lead?.owner_id ? `/leads?lead=${leadId}` : "/admin/ready-to-assign" },
            leadId,
        });
    } catch (e) {
        console.warn("[postCallOutcome] callback notification failed:", e instanceof Error ? e.message : e);
    }
}
