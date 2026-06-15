// Shared post-call pipeline for Bolna calls. Invoked from two entry points:
//
//   1. The Bolna webhook handler when Bolna POSTs us a terminal event
//      (status=completed | failed | etc).
//   2. /api/cron/dialer-poll and the dev-side polling tick when they detect
//      a terminal state by GETting Bolna's REST API.
//
// Both paths normalize their inputs into BolnaFinalizePayload and call
// finalizeBolnaCall, so behavior is identical regardless of how the call
// ending was discovered. claimCallForProcessing guarantees the heavy work
// runs exactly once per call_id.

import { analyzeTranscript } from "@/lib/ai/analysis";
import { db } from "@/lib/db";
import { aiCallLogs, dealerLeads, dialerCampaigns } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { reactivateLead } from "@/lib/leads/reactivation";
import { updateLeadAfterCall } from "../storage/leadStore";
import { completeCampaignLead } from "@/lib/queue/campaignTracker";
import { advanceCampaign } from "@/lib/queue/advanceCampaign";
import { scheduleCall } from "@/lib/queue/scheduler";
import { appendSalesCallLog, appendCallReview } from "@/lib/google/sheet";
import { resolveNextCallAt } from "@/lib/ai/analysis/postCallHelpers";
import { claimCallForProcessing } from "@/lib/ai/analysis/callClaim";
import { fetchAndPersistCallCost } from "@/lib/ai/storage/costStore";
import { rehostRecording } from "@/lib/ai/storage/recordingStore";

export type BolnaFinalizePayload = {
  callId: string;
  status: string;
  transcript: string | null;
  recordingUrl: string | null;
  duration: number | null;
  phone: string | null;
  // optional hint when the caller already knows the lead (the poller does;
  // the webhook usually doesn't and must look up by phone).
  leadId?: string;
  // optional structured conversation array for downstream callers that
  // want the raw turn-by-turn (Bolna may include `messages` on its body).
  conversation?: unknown[];
  // raw provider event id for sheet logging (Bolna calls it execution_id).
  executionId?: string;
};

// Statuses where the call is still in progress — these arrive on Bolna
// webhooks but should be ignored. Poll loop sees these as not-yet-terminal
// and waits for the next tick.
const IN_PROGRESS = new Set(["initiated", "ringing", "in-progress"]);

// Delay between completing one call and placing the next. Was 5s in the
// pre-DB-driven design; kept here so the campaign card has time to refresh
// and provider APIs aren't hammered.
const ADVANCE_DELAY_MS = 5_000;

export async function finalizeBolnaCall(
  payload: BolnaFinalizePayload,
): Promise<void> {
  const {
    callId,
    status,
    transcript,
    recordingUrl,
    duration,
    phone,
    leadId: leadIdHint,
    conversation,
    executionId,
  } = payload;

  if (IN_PROGRESS.has(status)) {
    return;
  }

  if (callId) {
    const claimed = await claimCallForProcessing("bolna", callId);
    if (!claimed) {
      console.log("[bolna:finalize] already processed:", callId);
      return;
    }
  }

  // ── No-transcript path: busy / failed / no-answer ──
  if (!transcript) {
    console.log(
      "[bolna:finalize] call ended without conversation, status:",
      status,
    );
    let leadForPhone:
      | {
          id: string;
          phone: string | null;
          shop_name: string | null;
          dealer_name: string | null;
        }
      | null
      | undefined = null;

    if (leadIdHint) {
      leadForPhone = await db.query.dealerLeads.findFirst({
        where: (l, { eq }) => eq(l.id, leadIdHint),
      });
    } else if (phone) {
      leadForPhone = await db.query.dealerLeads.findFirst({
        where: (l, { eq }) => eq(l.phone, phone),
      });
    }

    let campaignIdAfterComplete: string | null = null;
    if (leadForPhone) {
      await upsertAiCallLog({
        callId,
        leadId: leadForPhone.id,
        status: status || "failed",
        transcript: null,
        summary: null,
        recordingUrl,
        duration,
        phone: phone ?? leadForPhone.phone,
        intentScore: null,
        intentReason: null,
        nextAction: null,
      });

      // Even failed calls (e.g. answer-by-voicemail) accrue some cost on
      // Bolna's side. Best-effort fetch; backfill cron retries on race.
      await fetchAndPersistCallCost("bolna", callId);

      const r = await completeCampaignLead({
        leadId: leadForPhone.id,
        success: false,
        bolnaCallId: callId || null,
        outcome: status || "no_answer",
        intentScore: null,
      });
      campaignIdAfterComplete = r.campaignId;

      // "All calls" requirement: log no-conversation calls (no_answer / busy /
      // failed) to the Campaign_Call_Review sheet too. No transcript exists, so
      // the Transcript cell carries a short status note. Fire-and-forget —
      // including the campaign-name lookup — so it never blocks or breaks
      // finalization or campaign advancement. Values captured into consts since
      // `leadForPhone` is a `let` and loses its narrowing inside the closure.
      const reviewUuid = executionId ?? callId ?? "—";
      const reviewCompany = leadForPhone.shop_name ?? "—";
      const reviewDealer = leadForPhone.dealer_name ?? "—";
      const reviewCampaignId = r.campaignId;
      const reviewStatus = status || "no_answer";
      void (async () => {
        let campaign = reviewCampaignId ?? "—";
        if (reviewCampaignId) {
          const c = await db
            .select({ name: dialerCampaigns.name })
            .from(dialerCampaigns)
            .where(eq(dialerCampaigns.id, reviewCampaignId))
            .limit(1);
          campaign = c[0]?.name ?? reviewCampaignId;
        }
        const playableUrl = await rehostRecording({
          provider: "bolna",
          callId,
          recordingUrl,
        });
        await appendCallReview({
          uuid: reviewUuid,
          campaign,
          companyName: reviewCompany,
          dealerName: reviewDealer,
          recordingUrl: playableUrl,
          transcript: `No conversation (${reviewStatus})`,
        });
      })().catch((err) =>
        console.error("[bolna:finalize] call review log failed:", err),
      );
    }
    if (campaignIdAfterComplete) {
      await advanceCampaign(campaignIdAfterComplete, {
        preCallDelayMs: ADVANCE_DELAY_MS,
      });
    }
    return;
  }

  // ── Transcript path: real conversation ──
  // Locate the dealer_leads row first — both the scored and the analysis-failed
  // paths need it. Prefer the hint, then phone.
  let lead:
    | {
        id: string;
        phone: string | null;
        follow_up_history: unknown;
        shop_name: string | null;
        dealer_name: string | null;
      }
    | null
    | undefined = null;
  if (leadIdHint) {
    lead = await db.query.dealerLeads.findFirst({
      where: (l, { eq }) => eq(l.id, leadIdHint),
    });
  } else if (phone) {
    lead = await db.query.dealerLeads.findFirst({
      where: (l, { eq }) => eq(l.phone, phone),
    });
  }

  if (!lead) {
    console.warn("[bolna:finalize] no dealer_leads row for", {
      phone,
      leadIdHint,
    });
    return;
  }

  const result = await analyzeTranscript(transcript);

  // No silent zeros: on analysis failure (LLM/parse/timeout, or an
  // unintelligible call) mark needs_review, KEEP any prior score, and surface
  // the call for human follow-up — never disqualify a real lead on a 0.
  if (result.status === "failed") {
    console.error(
      `[bolna:finalize] analysis failed for lead ${lead.id}: ${result.reason}`,
    );
    const r = await markLeadNeedsReview({
      leadId: lead.id,
      followUpHistory: (lead.follow_up_history as unknown[]) || [],
      callId,
      status,
      transcript,
      recordingUrl,
      duration,
      phone: phone ?? lead.phone,
      conversation: conversation ?? [],
      reason: result.reason,
    });
    if (r.campaignId) {
      await advanceCampaign(r.campaignId, { preCallDelayMs: ADVANCE_DELAY_MS });
    }
    return;
  }

  const analysis = result;
  const action = analysis.action;
  const hardNegative = analysis.hard_negative;

  // ── dropped_empty: the line dropped before anything was captured (no info
  // signals, no callback). No band is written — the lead is left untouched and
  // the call is tagged so normal campaign scheduling re-attempts it. ──
  if (analysis.band === null) {
    const history = (lead.follow_up_history as unknown[]) || [];
    const droppedEntry = {
      attempt: history.length + 1,
      called_at: new Date().toISOString(),
      outcome: "dropped_empty",
      call_status: "dropped_empty",
      transcript,
      conversation: conversation ?? [],
      signals: analysis.signals,
      scoring_version: analysis.scoring_version,
      provider: "bolna",
    };
    await db
      .update(dealerLeads)
      .set({
        follow_up_history: [...history, droppedEntry],
        total_attempts: history.length + 1,
        call_status: "dropped_empty",
        // final_intent_score / current_status / interest_level intentionally
        // untouched — a dropped_empty call never bands the lead.
      })
      .where(eq(dealerLeads.id, lead.id));

    await upsertAiCallLog({
      callId,
      leadId: lead.id,
      status: status || "call-disconnected",
      transcript,
      summary: analysis.memory?.intent_summary
        ? `dropped_empty — ${analysis.memory.intent_summary}`
        : "dropped_empty — call cut off before anything was captured",
      recordingUrl,
      duration,
      phone: phone ?? lead.phone,
      intentScore: null,
      intentReason: null,
      nextAction: "auto_retry",
      scoringVersion: analysis.scoring_version,
      signals: analysis.signals,
      scoreBreakdown: analysis.score_breakdown,
      band: null,
      callStatus: "dropped_empty",
      infoSignalsCount: 0,
    });

    await fetchAndPersistCallCost("bolna", callId);
    const dr = await completeCampaignLead({
      leadId: lead.id,
      success: false,
      bolnaCallId: callId || null,
      outcome: "dropped_empty",
      intentScore: null,
    });
    if (dr.campaignId) {
      await advanceCampaign(dr.campaignId, { preCallDelayMs: ADVANCE_DELAY_MS });
    }
    return;
  }

  const nextCallAt = resolveNextCallAt(
    { callback_time: analysis.callback_time, intent_score: analysis.intent_score },
    transcript,
    action,
  );

  const updatedLead = updateLeadAfterCall(
    {
      ...lead,
      follow_up_history: (lead.follow_up_history as unknown[]) || [],
    },
    {
      transcript,
      outcome: analysis.outcome,
      nextCallAt,
      conversation: conversation ?? [],
      memory: analysis.memory,
      provider: "bolna",
      intentScore: analysis.intent_score,
      band: analysis.band,
      callStatus: analysis.call_status,
      infoSignalsCount: analysis.info_signals_count,
      signals: analysis.signals,
      scoreBreakdown: analysis.score_breakdown,
      scoringVersion: analysis.scoring_version,
      hardNegative,
    },
  );

  await db
    .update(dealerLeads)
    .set({
      follow_up_history: updatedLead.follow_up_history,
      total_attempts: updatedLead.total_attempts,
      final_intent_score: updatedLead.final_intent_score,
      current_status: updatedLead.current_status,
      interest_level: updatedLead.interest_level,
      call_status: updatedLead.call_status,
      info_signals_count: updatedLead.info_signals_count,
      intent_band: updatedLead.intent_band,
      memory: updatedLead.memory,
      next_call_at: nextCallAt,
    })
    .where(eq(dealerLeads.id, lead.id));

  // BRD §0.9 — reactivation on AI recall. If this was an AI re-engagement of
  // a Lost lead (ai_recall_status='awaiting_re_dial') and THIS call's intent
  // score clears the assignment threshold, reactivate the lead. Wrapped — a
  // reactivation failure must never break call finalization.
  try {
    await maybeReactivateOnRecall(lead.id, analysis.intent_score);
  } catch (err) {
    console.error("[bolna:finalize] recall reactivation failed:", err);
  }

  // Summary text feeds both the sheet logger and the transcript drawer.
  const summary = analysis.memory?.intent_summary
    ? `${analysis.band} — ${analysis.memory.intent_summary}`
    : `${analysis.band} — ${analysis.info_signals_count}/5 signals disclosed`;

  // Persist into ai_call_logs so the campaign transcript drawer can render
  // this call. Idempotent — upsert on call_id.
  await upsertAiCallLog({
    callId,
    leadId: lead.id,
    status: status || "completed",
    transcript,
    summary,
    recordingUrl,
    duration,
    phone: phone ?? lead.phone,
    intentScore: analysis.intent_score,
    intentReason: analysis.memory?.intent_summary ?? null,
    nextAction: action ?? null,
    scoringVersion: analysis.scoring_version,
    signals: analysis.signals,
    scoreBreakdown: analysis.score_breakdown,
    band: analysis.band,
    callStatus: analysis.call_status,
    infoSignalsCount: analysis.info_signals_count,
  });

  // Capture per-call cost from Bolna /executions/{id}. Best-effort: failure
  // is logged, never thrown. Backfill cron is the recovery path.
  await fetchAndPersistCallCost("bolna", callId);

  const completeR = await completeCampaignLead({
    leadId: lead.id,
    success: true,
    bolnaCallId: callId || null,
    outcome: analysis.outcome,
    intentScore: analysis.intent_score,
  });

  if (action === "schedule_call" && nextCallAt && phone) {
    const messageId = await scheduleCall({
      phone,
      leadId: lead.id,
      runAt: nextCallAt,
    });
    if (!messageId) {
      console.warn(
        `[bolna:finalize] scheduleCall returned null for ${lead.id} — call-scheduler cron is the recovery path`,
      );
    }
  }
  // Qualified (action push_to_crm) already lands current_status="qualified" via
  // updateLeadAfterCall above — the inside-sales queue reads it from there.

  appendSalesCallLog({
    leadId: lead.id,
    timestamp: new Date(),
    direction: "outbound",
    toNumber: phone ?? "",
    fromNumber: process.env.BOLNA_FROM_NUMBER ?? "—",
    transcript,
    summary,
    convId: executionId ?? callId ?? "—",
  }).catch((err) =>
    console.error("[bolna:finalize] sheet log failed:", err),
  );

  // Mirror this connected call into the Call_Review sheet so the reviewers can
  // leave feedback. Fire-and-forget — including the campaign-name lookup — so a
  // Sheets/DB hiccup never blocks or breaks finalization or campaign advance.
  // Values captured into consts because `lead` is a `let` and loses its
  // non-null narrowing inside the closure below.
  const reviewUuid = executionId ?? callId ?? "—";
  const reviewCompany = lead.shop_name ?? "—";
  const reviewDealer = lead.dealer_name ?? "—";
  const reviewCampaignId = completeR.campaignId;
  void (async () => {
    let campaign = reviewCampaignId ?? "—";
    if (reviewCampaignId) {
      const c = await db
        .select({ name: dialerCampaigns.name })
        .from(dialerCampaigns)
        .where(eq(dialerCampaigns.id, reviewCampaignId))
        .limit(1);
      campaign = c[0]?.name ?? reviewCampaignId;
    }
    const playableUrl = await rehostRecording({
      provider: "bolna",
      callId,
      recordingUrl,
    });
    await appendCallReview({
      uuid: reviewUuid,
      campaign,
      companyName: reviewCompany,
      dealerName: reviewDealer,
      recordingUrl: playableUrl,
      transcript,
    });
  })().catch((err) =>
    console.error("[bolna:finalize] call review log failed:", err),
  );

  if (completeR.campaignId) {
    await advanceCampaign(completeR.campaignId, {
      preCallDelayMs: ADVANCE_DELAY_MS,
    });
  }
}

// BRD §0.9 — when an AI re-engagement call (a Lost lead an admin pushed to
// the dialer, ai_recall_status='awaiting_re_dial') scores at or above the
// admin-tuned intent threshold, run the unified reactivation procedure and
// flip ai_recall_status to 'qualified'. Below threshold: leave it untouched
// so the dialer may retry per its own rules.
async function maybeReactivateOnRecall(
  leadId: string,
  score: number | null,
): Promise<void> {
  if (score == null) return;

  const rows = await db.execute<{
    lead_status: string | null;
    ai_recall_status: string | null;
  }>(sql`
    SELECT lead_status, ai_recall_status FROM dealer_leads
    WHERE id = ${leadId} LIMIT 1
  `);
  const r = rows[0];
  if (
    !r ||
    r.lead_status !== "Lost" ||
    r.ai_recall_status !== "awaiting_re_dial"
  ) {
    return;
  }

  const cfg = await db.execute<{ t: number | null }>(sql`
    SELECT intent_score_threshold AS t FROM assignment_config
    ORDER BY created_at ASC LIMIT 1
  `);
  const threshold = Number(cfg[0]?.t ?? 60);
  if (score < threshold) return;

  await reactivateLead({
    leadId,
    trigger: "ai_dialer",
    performedBy: null,
    notes: `AI re-engagement scored ${score}/100 (threshold ${threshold}) — reactivating.`,
  });
  await db.execute(sql`
    UPDATE dealer_leads SET ai_recall_status = 'qualified', updated_at = NOW()
    WHERE id = ${leadId}
  `);
}

// Upsert into ai_call_logs by call_id so re-finalizes (e.g. poll runs
// after the webhook already finalized) don't duplicate rows or revert
// fields. Generates a synthetic id when missing.
async function upsertAiCallLog(opts: {
  callId: string;
  leadId: string;
  status: string;
  transcript: string | null;
  summary: string | null;
  recordingUrl: string | null;
  duration: number | null;
  phone: string | null;
  intentScore: number | null;
  intentReason: string | null;
  nextAction: string | null;
  scoringVersion?: string | null;
  signals?: unknown;
  scoreBreakdown?: unknown;
  band?: string | null;
  callStatus?: string | null;
  infoSignalsCount?: number | null;
}): Promise<void> {
  try {
    const existing = opts.callId
      ? await db
          .select({ id: aiCallLogs.id })
          .from(aiCallLogs)
          .where(eq(aiCallLogs.call_id, opts.callId))
          .limit(1)
      : [];

    const now = new Date();

    if (existing.length > 0) {
      await db
        .update(aiCallLogs)
        .set({
          status: opts.status,
          transcript: opts.transcript,
          summary: opts.summary,
          recording_url: opts.recordingUrl,
          call_duration: opts.duration,
          intent_score: opts.intentScore,
          intent_reason: opts.intentReason,
          next_action: opts.nextAction,
          scoring_version: opts.scoringVersion ?? null,
          signals: opts.signals ?? null,
          score_breakdown: opts.scoreBreakdown ?? null,
          band: opts.band ?? null,
          call_status: opts.callStatus ?? null,
          info_signals_count: opts.infoSignalsCount ?? null,
          ended_at: now,
          updated_at: now,
        })
        .where(eq(aiCallLogs.id, existing[0].id));
      return;
    }

    const id = opts.callId ? `AICALL_${opts.callId}` : `AICALL_${Date.now()}`;
    await db.insert(aiCallLogs).values({
      id,
      call_id: opts.callId || id,
      lead_id: opts.leadId,
      provider: "bolna",
      status: opts.status,
      phone_number: opts.phone,
      transcript: opts.transcript,
      summary: opts.summary,
      recording_url: opts.recordingUrl,
      call_duration: opts.duration,
      intent_score: opts.intentScore,
      intent_reason: opts.intentReason,
      next_action: opts.nextAction,
      scoring_version: opts.scoringVersion ?? null,
      signals: opts.signals ?? null,
      score_breakdown: opts.scoreBreakdown ?? null,
      band: opts.band ?? null,
      call_status: opts.callStatus ?? null,
      info_signals_count: opts.infoSignalsCount ?? null,
      ended_at: now,
    });
  } catch (err) {
    console.error("[bolna:finalize] ai_call_logs upsert failed:", err);
  }
}

// Analysis-failure path: record the call as needs_review WITHOUT scoring it.
// Appends a flagged attempt to follow_up_history, leaves final_intent_score
// untouched (no demotion), and still completes the campaign lead so the dialer
// advances. Returns the campaign id so the caller can advance it.
async function markLeadNeedsReview(opts: {
  leadId: string;
  followUpHistory: unknown[];
  callId: string;
  status: string;
  transcript: string | null;
  recordingUrl: string | null;
  duration: number | null;
  phone: string | null;
  conversation: unknown[];
  reason: string;
}): Promise<{ campaignId: string | null }> {
  const history = opts.followUpHistory || [];
  const newEntry = {
    attempt: history.length + 1,
    called_at: new Date().toISOString(),
    outcome: "needs_review",
    analysis_failed: true,
    reason: opts.reason,
    transcript: opts.transcript || "",
    conversation: opts.conversation || [],
    provider: "bolna",
  };

  try {
    await db
      .update(dealerLeads)
      .set({
        follow_up_history: [...history, newEntry],
        total_attempts: history.length + 1,
        current_status: "needs_review",
        // final_intent_score intentionally untouched — keep any prior score.
      })
      .where(eq(dealerLeads.id, opts.leadId));
  } catch (err) {
    console.error("[bolna:finalize] needs_review update failed:", err);
  }

  await upsertAiCallLog({
    callId: opts.callId,
    leadId: opts.leadId,
    status: "needs_review",
    transcript: opts.transcript,
    summary: `analysis_failed — ${opts.reason}`,
    recordingUrl: opts.recordingUrl,
    duration: opts.duration,
    phone: opts.phone,
    intentScore: null,
    intentReason: opts.reason,
    nextAction: null,
  });

  await fetchAndPersistCallCost("bolna", opts.callId);

  const r = await completeCampaignLead({
    leadId: opts.leadId,
    success: true,
    bolnaCallId: opts.callId || null,
    outcome: "needs_review",
    intentScore: null,
  });
  return { campaignId: r.campaignId };
}
