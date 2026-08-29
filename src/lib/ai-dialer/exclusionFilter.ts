// BRD §0.2 — the AI-dialer exclusion filter.
//
// A phone is "AI-dialable" only when:
//   - it has never entered the Part-0 sales lifecycle (lead_status IS NULL)
//     and is not on the permanent do-not-call list (ai_recall_status =
//     'excluded', set on a business_closed Lost), OR
//   - it is a Lost lead an admin explicitly pushed back to the dialer
//     (lead_status = 'Lost' AND ai_recall_status = 'awaiting_re_dial').
//
// Anything in an active sales state (Assigned_Not_Contacted … Transferred_to_ASM,
// Converted) must NOT be called — the dialer must never re-contact a dealer
// that Inside Sales or an ASM is actively working.
//
// NOTE (no-regression): dealer_leads.lead_status is written ONLY by Part-0
// routes (claim / mark-* / touchpoint status change / bulk upload). Every
// pre-Part-0 scraped lead has lead_status = NULL, so it stays dialable. This
// filter only ever NARROWS the AI pool — it can never widen it.

import { and, eq, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { dealerLeads } from "@/lib/db/schema";

// ⚠⚠ THE THREE EXPORTS BELOW ARE SHARED WITH THE NEODOVE **HUMAN** CALLING PUSH.
//
//   AI_DIALABLE_SQL       → src/lib/ai-dialer/audience.ts:resolveAudience(), which is
//                           called by /api/ai-dialer/preview (AI) **and** by
//                           /api/neodove/campaigns/[id]/{route,preview,push} (HUMAN)
//   aiDialableCondition() → /api/cron/call (AI only)
//   isAiDialable()        → src/lib/queue/advanceCampaign.ts (AI) **and**
//                           /api/neodove/leads/push-batch + src/lib/neodove/pushOne.ts (HUMAN)
//
// DO NOT add "has the AI already spoken to this dealer?" to any of them. That rule
// belongs to the AI dialer alone — an AI-connected lead is precisely the one the
// human calling team is supposed to receive, and folding the rule in here would
// silently close the "follow up manually" escape hatch that the hard block's own
// notice points at. The rule lives in AI_NOT_YET_CONNECTED_SQL /
// notYetAiConnectedCondition() below, opted into per call site.
//
// src/lib/ai-dialer/__tests__/exclusionFilter.test.ts fails if this is violated.

// The predicate text, exported separately so the guard test can assert on it
// without a database. AI_DIALABLE_SQL is built from it and is unchanged.
export const AI_DIALABLE_PREDICATE =
    "(" +
    "(dl.lead_status IS NULL AND " +
    "(dl.ai_recall_status IS NULL OR dl.ai_recall_status <> 'excluded'))" +
    " OR " +
    "(dl.lead_status = 'Lost' AND dl.ai_recall_status = 'awaiting_re_dial')" +
    ")";

// Raw SQL predicate for hand-written queries. The dealer_leads table MUST be
// aliased `dl` at the call site.
export const AI_DIALABLE_SQL = sql.raw(AI_DIALABLE_PREDICATE);

// Drizzle condition for query-builder call sites (cron, campaign advance).
export function aiDialableCondition(): SQL {
    return or(
        and(
            isNull(dealerLeads.lead_status),
            or(
                isNull(dealerLeads.ai_recall_status),
                ne(dealerLeads.ai_recall_status, "excluded"),
            ),
        ),
        and(
            eq(dealerLeads.lead_status, "Lost"),
            eq(dealerLeads.ai_recall_status, "awaiting_re_dial"),
        ),
    ) as SQL;
}

// In-memory predicate for rows already fetched — e.g. a defensive re-check
// mid-campaign, where the lead's state may have changed since it was queued.
export function isAiDialable(row: {
    lead_status?: string | null;
    ai_recall_status?: string | null;
}): boolean {
    const status = row.lead_status ?? null;
    const recall = row.ai_recall_status ?? null;
    if (status === null) return recall !== "excluded";
    return status === "Lost" && recall === "awaiting_re_dial";
}

// ── AI-DIALER ONLY, from here down ────────────────────────────────────────
//
// "Already had a real conversation with the AI." A lead in this state can never
// be added to another AI dialer campaign — there is no AI follow-up capability,
// so a second robot call to the same dealer is pure downside. It is NOT excluded
// from the human calling team; that is the whole point (see the header above).
//
// CONNECTED := ai_call_logs.transcript IS NOT NULL.
// This is not a new judgement: finalizeCall.ts already branches on `if
// (!transcript)` to decide success vs telephony failure, and that branch stores
// transcript = NULL. So call_status complete / dropped_partial / dropped_empty
// all count as connected, and no_answer / busy / failed do not.
//
// Evaluated live rather than denormalised onto dealer_leads: ai_call_logs is
// small and already carries ai_call_logs_lead_id_idx, whereas a column would
// need a backfill, a new write in BOTH providers' private upsertAiCallLog, and
// would become a third source of truth that can disagree with the transcript
// itself. If ai_call_logs ever passes ~1M rows, add a partial index instead:
//   CREATE INDEX CONCURRENTLY ai_call_logs_connected_lead_idx
//       ON ai_call_logs (lead_id) WHERE transcript IS NOT NULL;

/** Raw predicate — dealer_leads MUST be aliased `dl`. */
export const AI_CONNECTED_PREDICATE =
    "EXISTS (SELECT 1 FROM ai_call_logs acl" +
    " WHERE acl.lead_id = dl.id AND acl.transcript IS NOT NULL)";

export const AI_CONNECTED_SQL = sql.raw(AI_CONNECTED_PREDICATE);
export const AI_NOT_YET_CONNECTED_SQL = sql.raw(`NOT ${AI_CONNECTED_PREDICATE}`);

/** Any AI call attempt at all, connected or not. Powers the "we tried and
 *  nobody picked up" campaign filter. */
export const AI_ATTEMPTED_PREDICATE =
    "EXISTS (SELECT 1 FROM ai_call_logs acl WHERE acl.lead_id = dl.id)";

export const AI_ATTEMPTED_SQL = sql.raw(AI_ATTEMPTED_PREDICATE);

// Already sitting in a queue that will actually be dialled.
//
// Expressed as "the parent campaign is NOT terminal" rather than "the parent is
// running", so an unknown or future status ('scheduled' from E-228, 'draft')
// fails SAFE — it excludes rather than double-dials. Terminal parents are
// excluded deliberately: there is a backlog of pending rows hanging off
// completed/stopped campaigns that will never be dialled, and treating those as
// "queued" would retire those leads permanently.
export const IN_LIVE_DIALER_QUEUE_PREDICATE =
    "EXISTS (SELECT 1 FROM dialer_campaign_leads dcl" +
    " JOIN dialer_campaigns dc ON dc.id = dcl.campaign_id" +
    " WHERE dcl.lead_id = dl.id" +
    " AND dcl.status IN ('pending', 'calling')" +
    " AND dc.status NOT IN ('completed', 'stopped', 'failed'))";

export const IN_LIVE_DIALER_QUEUE_SQL = sql.raw(IN_LIVE_DIALER_QUEUE_PREDICATE);
export const NOT_IN_LIVE_DIALER_QUEUE_SQL = sql.raw(
    `NOT ${IN_LIVE_DIALER_QUEUE_PREDICATE}`,
);

/** Drizzle-composable form, for query-builder call sites (e.g. /api/cron/call).
 *  A correlated EXISTS has no relational-builder shape, so this is sql`` that
 *  references the column object and composes with and()/or(). */
export function notYetAiConnectedCondition(): SQL {
    return sql`NOT EXISTS (
        SELECT 1 FROM ai_call_logs acl
         WHERE acl.lead_id = ${dealerLeads.id} AND acl.transcript IS NOT NULL
    )`;
}

// The AI's own follow-up loop retires when a lead becomes AI-connected.
//
// dealer_leads.next_call_at is written ONLY by resolveNextCallAt() on the
// transcript path, so EVERY lead the call-schedulers dial is AI-connected by
// construction. Blocking there therefore does not "also cover" the schedulers —
// it switches the Warm-band nurture loop off entirely, and hands those dealers
// to Inside Sales instead. That is the intended behaviour, but it is a
// behaviour RETIREMENT rather than an incidental consequence, so it lives
// behind one named constant that a reviewer can flip in a single line.
//
// When blocking, the scheduler MUST also clear next_call_at — leaving it set
// makes the cron re-select the same lead every tick, forever.
export const AI_FOLLOWUP_LOOP_RETIRES_CONNECTED = true;
