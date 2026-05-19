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
import { decideNextAction } from "@/lib/ai/decision/engine";
import { db } from "@/lib/db";
import { aiCallLogs, dealerLeads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { updateLeadAfterCall } from "../storage/leadStore";
import { completeCampaignLead } from "@/lib/queue/campaignTracker";
import { advanceCampaign } from "@/lib/queue/advanceCampaign";
import { scheduleCall } from "@/lib/queue/scheduler";
import { appendSalesCallLog } from "@/lib/google/sheet";
import {
  normalizeAnalysis,
  resolveNextCallAt,
} from "@/lib/ai/analysis/postCallHelpers";
import { claimCallForProcessing } from "@/lib/ai/analysis/callClaim";
import { fetchAndPersistCallCost } from "@/lib/ai/storage/costStore";

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
      | { id: string; phone: string | null }
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
    }
    if (campaignIdAfterComplete) {
      await advanceCampaign(campaignIdAfterComplete, {
        preCallDelayMs: ADVANCE_DELAY_MS,
      });
    }
    return;
  }

  // ── Transcript path: real conversation ──
  const rawAnalysis = await analyzeTranscript(transcript);
  const analysis = normalizeAnalysis(rawAnalysis);
  const decision = decideNextAction(analysis.intent_score, analysis.outcome);
  const nextCallAt = resolveNextCallAt(analysis, transcript, decision.action);

  // Locate the dealer_leads row. Prefer the hint, then phone.
  let lead:
    | { id: string; phone: string | null; follow_up_history: unknown }
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

  const updatedLead = updateLeadAfterCall(
    {
      ...lead,
      follow_up_history: (lead.follow_up_history as unknown[]) || [],
    },
    {
      transcript,
      outcome: analysis.outcome,
      nextCallAt,
      analysis: analysis.analysis,
      conversation: conversation ?? [],
      memory: analysis.memory,
      provider: "bolna",
    },
  );

  await db
    .update(dealerLeads)
    .set({
      follow_up_history: updatedLead.follow_up_history,
      total_attempts: updatedLead.total_attempts,
      final_intent_score: updatedLead.final_intent_score,
      current_status: updatedLead.current_status,
      memory: updatedLead.memory,
      next_call_at: nextCallAt,
    })
    .where(eq(dealerLeads.id, lead.id));

  // Summary text feeds both the sheet logger and the transcript drawer.
  const summary = analysis.memory?.intent_summary
    ? `${analysis.outcome} — ${analysis.memory.intent_summary}`
    : `${analysis.outcome} — Intent: ${analysis.intent_score}/100`;

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
    nextAction: decision.action ?? null,
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

  if (decision.action === "schedule_call" && nextCallAt && phone) {
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

  if (decision.action === "push_to_crm") {
    await db
      .update(dealerLeads)
      .set({ current_status: "qualified" })
      .where(eq(dealerLeads.id, lead.id));
  }

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

  if (completeR.campaignId) {
    await advanceCampaign(completeR.campaignId, {
      preCallDelayMs: ADVANCE_DELAY_MS,
    });
  }
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
      ended_at: now,
    });
  } catch (err) {
    console.error("[bolna:finalize] ai_call_logs upsert failed:", err);
  }
}
