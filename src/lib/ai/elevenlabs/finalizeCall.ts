// Shared post-call pipeline for ElevenLabs calls. See finalizeCall.ts in the
// Bolna folder for the design rationale — this is the symmetric version.

import { analyzeTranscript } from "@/lib/ai/analysis";
import { db } from "@/lib/db";
import { aiCallLogs, dealerLeads, dialerCampaigns } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { updateLeadAfterCall } from "../storage/leadStore";
import { completeCampaignLead } from "@/lib/queue/campaignTracker";
import { advanceCampaign } from "@/lib/queue/advanceCampaign";
import { scheduleElevenLabsCall } from "@/lib/queue/scheduler";
import { appendSalesCallLog, appendCallReview } from "@/lib/google/sheet";
import { resolveNextCallAt } from "@/lib/ai/analysis/postCallHelpers";
import { claimCallForProcessing } from "@/lib/ai/analysis/callClaim";
import { fetchAndPersistCallCost } from "@/lib/ai/storage/costStore";
import {
  rehostRecording,
  rehostElevenLabsRecording,
} from "@/lib/ai/storage/recordingStore";

export type ElevenLabsFinalizePayload = {
  conversationId: string;
  status: string;
  transcript: string | null;
  recordingUrl: string | null;
  duration: number | null;
  phone: string | null;
  leadId?: string;
  conversation?: unknown[];
  /**
   * When the call actually happened, from the provider's own clock.
   *
   * These exist because every date-bounded query on /operations/elevenlabs
   * buckets on `ended_at` (see cost-analytics-query.ts istDayBounds). Stamping
   * write time instead — which is what this pipeline did — files a webhook that
   * arrives at 00:05 IST against the wrong day, and a backfilled or retried
   * call against the wrong month entirely. The provider knows when the call
   * ended; we should not be guessing from when we got told.
   */
  startedAt?: Date | null;
  endedAt?: Date | null;
  /** ElevenLabs agent that handled the call. Present on the payload, never stored until now. */
  agentId?: string | null;
};

const IN_PROGRESS = new Set(["initiated", "ringing", "in-progress"]);
const ADVANCE_DELAY_MS = 5_000;

// Resolve a browser-playable recording URL for an ElevenLabs call. ElevenLabs
// doesn't hand back a hosted recording URL on the webhook/poll (unlike Bolna),
// so prefer an explicit URL if one ever appears, otherwise pull the audio bytes
// from the conversation /audio endpoint and re-host them. Returns "" if no
// recording could be produced.
async function resolveElevenLabsPlayableUrl(
  conversationId: string,
  recordingUrl: string | null,
): Promise<string> {
  if (recordingUrl) {
    return rehostRecording({
      provider: "elevenlabs",
      callId: conversationId,
      recordingUrl,
    });
  }
  return rehostElevenLabsRecording(conversationId);
}

export async function finalizeElevenLabsCall(
  payload: ElevenLabsFinalizePayload,
): Promise<void> {
  const {
    conversationId,
    status,
    transcript,
    recordingUrl,
    duration,
    phone,
    leadId: leadIdHint,
    conversation,
    startedAt,
    endedAt,
    agentId,
  } = payload;

  if (IN_PROGRESS.has(status)) {
    return;
  }

  if (conversationId) {
    const claimed = await claimCallForProcessing("elevenlabs", conversationId);
    if (!claimed) {
      console.log("[elevenlabs:finalize] already processed:", conversationId);
      return;
    }
  }

  if (!transcript) {
    console.log(
      "[elevenlabs:finalize] no transcript on terminal event, status:",
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

    // Logged FIRST, and unconditionally — outside the `if (leadForPhone)` this
    // used to sit inside. A call we cannot attribute to a dealer_lead is still
    // a call that was placed, billed and counted by the provider; dropping it
    // is how the dashboard came to show 0 calls against 738 real ones. Inbound
    // calls have no lead_id at all and their external_number arrives in local
    // format (08035315136) that will never match a stored +91 number, so this
    // branch is the *normal* path for them, not an edge case.
    await upsertAiCallLog({
      callId: conversationId,
      leadId: leadForPhone?.id ?? null,
      startedAt,
      endedAt,
      agentId,
      status: status || "failed",
      transcript: null,
      summary: null,
      recordingUrl,
      duration,
      phone: phone ?? leadForPhone?.phone ?? null,
      intentScore: null,
      intentReason: null,
      nextAction: null,
    });

    // Even failed calls (initiation_failure, busy, no-answer) accrue partial
    // cost on ElevenLabs. Best-effort fetch; backfill retries. Also moved out
    // of the lead check: costStore keys on call_id, which now always exists, so
    // an unattributed call still gets its cost — and the cost column is what
    // the Cost tile sums.
    await fetchAndPersistCallCost("elevenlabs", conversationId);

    if (leadForPhone) {
      const r = await completeCampaignLead({
        leadId: leadForPhone.id,
        success: false,
        bolnaCallId: conversationId || null,
        outcome: status || "no_transcript",
        intentScore: null,
      });
      campaignIdAfterComplete = r.campaignId;

      // "All calls" requirement: log no-conversation calls to the
      // Campaign_Call_Review sheet too. No transcript exists, so the Transcript
      // cell carries a short status note. Fire-and-forget — including the
      // campaign-name lookup and recording re-host — so it never blocks or
      // breaks finalization or campaign advancement. Values captured into consts
      // since `leadForPhone` is a `let` and loses its narrowing in the closure.
      const reviewUuid = conversationId ?? "—";
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
        const playableUrl = await resolveElevenLabsPlayableUrl(
          conversationId,
          recordingUrl,
        );
        await appendCallReview({
          uuid: reviewUuid,
          campaign,
          companyName: reviewCompany,
          dealerName: reviewDealer,
          recordingUrl: playableUrl,
          transcript: `No conversation (${reviewStatus})`,
        });
      })().catch((err) =>
        console.error("[elevenlabs:finalize] call review log failed:", err),
      );
    }
    if (campaignIdAfterComplete) {
      await advanceCampaign(campaignIdAfterComplete, {
        preCallDelayMs: ADVANCE_DELAY_MS,
      });
    }
    return;
  }

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
    console.warn("[elevenlabs:finalize] no dealer_leads row for", {
      phone,
      leadIdHint,
    });
    // Log the call before giving up on attributing it. The transcript exists
    // and the provider has already billed for it; only the CRM linkage is
    // missing. Returning here without a write — which is what this did — meant
    // a real, paid-for conversation left no trace anywhere in the product.
    //
    // Analysis is deliberately skipped: scoring writes back to a dealer_lead,
    // and there is none. The row carries the transcript so the call can be
    // attributed by hand later, and re-finalizing after the lead exists will
    // upsert the score onto this same row.
    await upsertAiCallLog({
      callId: conversationId,
      leadId: null,
      startedAt,
      endedAt,
      agentId,
      status: status || "completed",
      transcript,
      summary: null,
      recordingUrl,
      duration,
      phone,
      intentScore: null,
      intentReason: null,
      nextAction: null,
      callStatus: "unattributed",
    });
    await fetchAndPersistCallCost("elevenlabs", conversationId);
    return;
  }

  const result = await analyzeTranscript(transcript);

  // No silent zeros: on analysis failure mark needs_review, KEEP any prior
  // score, and surface the call for human follow-up.
  if (result.status === "failed") {
    console.error(
      `[elevenlabs:finalize] analysis failed for lead ${lead.id}: ${result.reason}`,
    );
    const r = await markLeadNeedsReview({
      leadId: lead.id,
      followUpHistory: (lead.follow_up_history as unknown[]) || [],
      callId: conversationId,
      status,
      transcript,
      recordingUrl,
      duration,
      phone: phone ?? lead.phone,
      conversation: conversation ?? [],
      reason: result.reason,
      startedAt,
      endedAt,
      agentId,
    });
    if (r.campaignId) {
      await advanceCampaign(r.campaignId, { preCallDelayMs: ADVANCE_DELAY_MS });
    }
    return;
  }

  const analysis = result;
  const action = analysis.action;
  const hardNegative = analysis.hard_negative;

  // ── dropped_empty: line dropped before anything was captured. No band is
  // written; tag the call and let normal scheduling re-attempt it. ──
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
      provider: "elevenlabs",
    };
    await db
      .update(dealerLeads)
      .set({
        follow_up_history: [...history, droppedEntry],
        total_attempts: history.length + 1,
        call_status: "dropped_empty",
        provider: "elevenlabs",
      })
      .where(eq(dealerLeads.id, lead.id));

    await upsertAiCallLog({
      callId: conversationId,
      leadId: lead.id,
      startedAt,
      endedAt,
      agentId,
      status: status || "call-disconnected",
      transcript,
      summary: "dropped_empty — call cut off before anything was captured",
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

    await fetchAndPersistCallCost("elevenlabs", conversationId);
    const dr = await completeCampaignLead({
      leadId: lead.id,
      success: false,
      bolnaCallId: conversationId || null,
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
      provider: "elevenlabs",
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
      provider: "elevenlabs",
    })
    .where(eq(dealerLeads.id, lead.id));

  const summary = analysis.memory?.intent_summary
    ? `${analysis.band} — ${analysis.memory.intent_summary}`
    : `${analysis.band} — ${analysis.info_signals_count}/5 signals disclosed`;

  await upsertAiCallLog({
    callId: conversationId,
    leadId: lead.id,
    startedAt,
    endedAt,
    agentId,
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

  // Capture per-call cost from ElevenLabs /v1/convai/conversations/{id}.
  // Best-effort: backfill cron is the recovery path on race or 5xx.
  await fetchAndPersistCallCost("elevenlabs", conversationId);

  const completeR = await completeCampaignLead({
    leadId: lead.id,
    success: true,
    bolnaCallId: conversationId || null,
    outcome: analysis.outcome,
    intentScore: analysis.intent_score,
  });

  if (action === "schedule_call" && nextCallAt && phone) {
    const messageId = await scheduleElevenLabsCall({
      phone,
      leadId: lead.id,
      runAt: nextCallAt,
    });
    if (!messageId) {
      console.warn(
        `[elevenlabs:finalize] scheduleElevenLabsCall returned null for ${lead.id} — call-scheduler cron is the recovery path`,
      );
    }
  }
  // Qualified (action push_to_crm) already lands current_status="qualified" via
  // updateLeadAfterCall above.

  appendSalesCallLog({
    leadId: lead.id,
    timestamp: new Date(),
    direction: "outbound",
    toNumber: phone ?? "",
    fromNumber: process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID ?? "—",
    transcript,
    summary,
    convId: conversationId ?? "—",
  }).catch((err) =>
    console.error("[elevenlabs:finalize] sheet log failed:", err),
  );

  // Mirror this connected call into the Campaign_Call_Review sheet so the
  // reviewers can leave feedback. Fire-and-forget — including the campaign-name
  // lookup and recording re-host — so it never blocks or breaks finalization or
  // campaign advance. Values captured into consts because `lead` is a `let` and
  // loses its non-null narrowing inside the closure below.
  const reviewUuid = conversationId ?? "—";
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
    const playableUrl = await resolveElevenLabsPlayableUrl(
      conversationId,
      recordingUrl,
    );
    await appendCallReview({
      uuid: reviewUuid,
      campaign,
      companyName: reviewCompany,
      dealerName: reviewDealer,
      recordingUrl: playableUrl,
      transcript,
    });
  })().catch((err) =>
    console.error("[elevenlabs:finalize] call review log failed:", err),
  );

  if (completeR.campaignId) {
    await advanceCampaign(completeR.campaignId, {
      preCallDelayMs: ADVANCE_DELAY_MS,
    });
  }
}

async function upsertAiCallLog(opts: {
  callId: string;
  /**
   * Null when no dealer_leads row matched.
   *
   * It used to be impossible to get here without a lead, because every caller
   * returned early instead — which is how 738 August calls became zero rows.
   * `lead_id` is nullable in the database; an unattributed call is a real call
   * and belongs in the log.
   */
  leadId: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
  agentId?: string | null;
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
    const now = new Date();
    // Prefer the provider's clock; fall back to write time only when the
    // payload carried no timestamp at all.
    const endedAt = opts.endedAt ?? now;
    const id = opts.callId ? `AICALL_${opts.callId}` : `AICALL_${Date.now()}`;

    // Fields that always reflect the latest word from the provider. A
    // redelivery carries the same or better information, so overwriting is
    // correct for these.
    const latest = {
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
    };

    // A REAL upsert against ai_call_logs_call_id_unique, not a SELECT then an
    // INSERT. The old shape had a race between the two statements that the
    // unique constraint turned into a 23505 — which the catch below swallowed,
    // silently dropping the second write. ElevenLabs redelivers, and two pm2
    // workers can finalize the same call when the Redis claim degrades to its
    // process-local fallback, so that race was reachable in production.
    //
    // The conditional spreads are the no-clobber rule: a field the provider did
    // not send this time must not overwrite a good value stored last time.
    await db
      .insert(aiCallLogs)
      .values({
        id,
        call_id: opts.callId || id,
        lead_id: opts.leadId,
        provider: "elevenlabs",
        phone_number: opts.phone,
        started_at: opts.startedAt ?? null,
        ended_at: endedAt,
        agent_id: opts.agentId ?? null,
        ...latest,
      })
      .onConflictDoUpdate({
        target: aiCallLogs.call_id,
        set: {
          ...latest,
          ended_at: endedAt,
          updated_at: now,
          ...(opts.startedAt ? { started_at: opts.startedAt } : {}),
          ...(opts.agentId ? { agent_id: opts.agentId } : {}),
          ...(opts.leadId ? { lead_id: opts.leadId } : {}),
          ...(opts.phone ? { phone_number: opts.phone } : {}),
        },
      });
  } catch (err) {
    console.error("[elevenlabs:finalize] ai_call_logs upsert failed:", err);
  }
}

// Analysis-failure path (symmetric with the Bolna pipeline): record the call as
// needs_review WITHOUT scoring it, leave final_intent_score untouched, and still
// complete the campaign lead so the dialer advances.
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
  startedAt?: Date | null;
  endedAt?: Date | null;
  agentId?: string | null;
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
    provider: "elevenlabs",
  };

  try {
    await db
      .update(dealerLeads)
      .set({
        follow_up_history: [...history, newEntry],
        total_attempts: history.length + 1,
        current_status: "needs_review",
        provider: "elevenlabs",
      })
      .where(eq(dealerLeads.id, opts.leadId));
  } catch (err) {
    console.error("[elevenlabs:finalize] needs_review update failed:", err);
  }

  await upsertAiCallLog({
    callId: opts.callId,
    leadId: opts.leadId,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    agentId: opts.agentId,
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

  await fetchAndPersistCallCost("elevenlabs", opts.callId);

  const r = await completeCampaignLead({
    leadId: opts.leadId,
    success: true,
    bolnaCallId: opts.callId || null,
    outcome: "needs_review",
    intentScore: null,
  });
  return { campaignId: r.campaignId };
}
