// Shared post-call pipeline for ElevenLabs calls. See finalizeCall.ts in the
// Bolna folder for the design rationale — this is the symmetric version.

import { analyzeTranscript } from "@/lib/ai/analysis";
import { decideNextAction } from "@/lib/ai/decision/engine";
import { db } from "@/lib/db";
import { aiCallLogs, dealerLeads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { updateLeadAfterCall } from "../storage/leadStore";
import { completeCampaignLead } from "@/lib/queue/campaignTracker";
import { advanceCampaign } from "@/lib/queue/advanceCampaign";
import { scheduleElevenLabsCall } from "@/lib/queue/scheduler";
import { appendSalesCallLog } from "@/lib/google/sheet";
import {
  normalizeAnalysis,
  resolveNextCallAt,
} from "@/lib/ai/analysis/postCallHelpers";
import { claimCallForProcessing } from "@/lib/ai/analysis/callClaim";

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

      const r = await completeCampaignLead({
        leadId: leadForPhone.id,
        success: false,
        bolnaCallId: conversationId || null,
        outcome: status || "no_transcript",
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

  const rawAnalysis = await analyzeTranscript(transcript);
  const analysis = normalizeAnalysis(rawAnalysis);
  const decision = decideNextAction(analysis.intent_score, analysis.outcome);
  const nextCallAt = resolveNextCallAt(analysis, transcript, decision.action);

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
    console.warn("[elevenlabs:finalize] no dealer_leads row for", {
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
      provider: "elevenlabs",
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
      provider: "elevenlabs",
    })
    .where(eq(dealerLeads.id, lead.id));

  const summary = analysis.memory?.intent_summary
    ? `${analysis.outcome} — ${analysis.memory.intent_summary}`
    : `${analysis.outcome} — Intent: ${analysis.intent_score}/100`;

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
    nextAction: decision.action ?? null,
  });

  const completeR = await completeCampaignLead({
    leadId: lead.id,
    success: true,
    bolnaCallId: conversationId || null,
    outcome: analysis.outcome,
    intentScore: analysis.intent_score,
  });

  if (decision.action === "schedule_call" && nextCallAt && phone) {
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
    fromNumber: process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID ?? "—",
    transcript,
    summary,
    convId: conversationId ?? "—",
  }).catch((err) =>
    console.error("[elevenlabs:finalize] sheet log failed:", err),
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
      ended_at: now,
    });
  } catch (err) {
    console.error("[elevenlabs:finalize] ai_call_logs upsert failed:", err);
  }
}
