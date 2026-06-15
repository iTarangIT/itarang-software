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
    if (leadForPhone) {
      await upsertAiCallLog({
        callId: conversationId,
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

      // Even failed calls (initiation_failure, busy, no-answer) accrue
      // partial cost on ElevenLabs. Best-effort fetch; backfill retries.
      await fetchAndPersistCallCost("elevenlabs", conversationId);

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
      provider: "elevenlabs",
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
