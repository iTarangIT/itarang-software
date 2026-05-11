import { analyzeTranscript } from "@/lib/ai/analysis";
import { decideNextAction } from "@/lib/ai/decision/engine";
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { updateLeadAfterCall } from "../storage/leadStore";
import { dealerLeads } from "@/lib/db/schema";
import { dedupClaim } from "@/lib/queue/safeRedis";
import { dialerSession } from "@/lib/queue/dialerSession";
import { scheduleElevenLabsCall } from "@/lib/queue/scheduler";
import { appendSalesCallLog } from "@/lib/google/sheet";
import { triggerElevenLabsCall } from "./triggerCall";
import type { ElevenLabsWebhookEvent, ElevenLabsTranscriptTurn } from "./types";

const PROCESSED_CALL_TTL_SECONDS = 10 * 60;

async function claimCallForProcessing(callId: string): Promise<boolean> {
  const { claimed, degraded } = await dedupClaim(
    `elevenlabs:processed-call:${callId}`,
    PROCESSED_CALL_TTL_SECONDS,
    "elevenlabs:webhook-dedup",
  );
  if (degraded) {
    console.warn(
      `[elevenlabs:webhook] dedup falling back to process-local LRU (Redis degraded) for ${callId}`,
    );
  }
  return claimed;
}

function getValidDate(input: any): Date | null {
  if (!input) return null;
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d;
}

function transcriptArrayToString(turns?: ElevenLabsTranscriptTurn[]): string {
  if (!Array.isArray(turns) || turns.length === 0) return "";
  return turns
    .map((t) => {
      const role = (t.role || "").toLowerCase();
      const speaker = role === "user" ? "user" : role === "agent" ? "agent" : role;
      const message = (t.message || "").trim();
      return message ? `${speaker}: ${message}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractDealerLines(transcript: string): string {
  return transcript
    .split("\n")
    .filter((line) => line.toLowerCase().startsWith("user:"))
    .map((line) => line.replace(/^user:\s*/i, ""))
    .join(" ");
}

function parseCallbackTimeFromTranscript(transcript: string): Date | null {
  if (!transcript) return null;

  const now = Date.now();
  const t = extractDealerLines(transcript).toLowerCase();

  const patterns: { regex: RegExp; multiplierMs: number }[] = [
    { regex: /(\d+)\s*(second|sec|सेकंड)/i, multiplierMs: 1000 },
    { regex: /(\d+)\s*(minute|min|मिनट|मिनिट|मिन)/i, multiplierMs: 60 * 1000 },
    {
      regex: /(\d+)\s*(hour|hr|घंटा|घंटे|ghanta|ghante)/i,
      multiplierMs: 60 * 60 * 1000,
    },
    { regex: /(\d+)\s*(day|din|दिन)/i, multiplierMs: 24 * 60 * 60 * 1000 },
  ];

  for (const { regex, multiplierMs } of patterns) {
    const match = t.match(regex);
    if (match) {
      const value = parseInt(match[1], 10);
      if (!isNaN(value) && value > 0) {
        return new Date(now + value * multiplierMs);
      }
    }
  }

  if (/kal|tomorrow|कल/.test(t)) return new Date(now + 24 * 60 * 60 * 1000);
  if (/parso|day after|परसों/.test(t))
    return new Date(now + 48 * 60 * 60 * 1000);
  if (/thodi der|thoda time|थोड़ी देर|थोड़ा टाइम/.test(t))
    return new Date(now + 30 * 60 * 1000);

  return null;
}

function normalizeAnalysis(analysis: any) {
  const safe = {
    outcome: analysis.outcome || "unknown",
    callback_time: analysis.callback_time || null,
    intent_score: Math.max(
      0,
      Math.min(100, Number(analysis.intent_score || 0)),
    ),
    analysis: analysis.analysis || {
      next_step_commitment: 0,
      urgency_signals: 0,
      product_curiosity: 0,
      need_acknowledgment: 0,
      objection_quality: 0,
      engagement_depth: 0,
      intent_score: 0,
    },
    memory: analysis.memory || {},
  };

  const hasQuantity = !!safe.memory?.quantity;
  const hasCallback =
    safe.outcome === "callback_requested" ||
    (safe.memory?.followup_reason || "").toLowerCase().includes("callback");

  if (hasCallback) safe.outcome = "callback_requested";
  if (hasQuantity && safe.analysis.product_curiosity < 5)
    safe.analysis.product_curiosity = 7;
  if (hasCallback && safe.intent_score < 50) safe.intent_score = 60;
  if (hasQuantity && hasCallback && safe.intent_score < 70)
    safe.intent_score = 75;

  return safe;
}

function resolveNextCallAt(
  analysis: any,
  transcript: string,
  action: string,
): Date | null {
  if (action !== "schedule_call") return null;

  const fromGemini = getValidDate(analysis.callback_time);
  if (fromGemini) return fromGemini;

  const fromTranscript = parseCallbackTimeFromTranscript(transcript);
  if (fromTranscript) return fromTranscript;

  const score = analysis.intent_score;
  const delayMs =
    score >= 75
      ? 30 * 60 * 1000
      : score >= 50
        ? 2 * 60 * 60 * 1000
        : 24 * 60 * 60 * 1000;

  return new Date(Date.now() + delayMs);
}

async function advanceDialerToNextLead() {
  if (!(await dialerSession.isActive())) return;

  let nextLead = null;
  while (await dialerSession.isActive()) {
    const nextLeadId = await dialerSession.getNext();
    if (!nextLeadId) {
      console.log("[ELEVENLABS] AI DIALER: queue complete, all leads called");
      break;
    }

    const candidate = await db.query.dealerLeads.findFirst({
      where: (l, { eq }) => eq(l.id, nextLeadId),
    });

    if (candidate?.phone) {
      nextLead = candidate;
      break;
    }

    console.log("[ELEVENLABS] AI DIALER: skipping lead with no phone", nextLeadId);
  }

  if (nextLead) {
    console.log("[ELEVENLABS] AI DIALER: calling next lead", {
      id: nextLead.id,
      phone: nextLead.phone,
      remaining: await dialerSession.remaining(),
    });

    await new Promise((r) => setTimeout(r, 5000));

    await triggerElevenLabsCall({
      phone: nextLead.phone!,
      leadId: nextLead.id,
    });
  }
}

export async function handleElevenLabsWebhook(event: ElevenLabsWebhookEvent) {
  try {
    if (event.type === "post_call_audio") {
      // Audio webhook is informational only; we don't store audio.
      return;
    }

    if (event.type === "call_initiation_failure") {
      const data = event.data;
      console.log("[ELEVENLABS] Call initiation failed:", {
        conversation_id: data.conversation_id,
        reason: data.failure_reason,
      });
      // Failed initiations should still advance the dialer.
      await advanceDialerToNextLead();
      return;
    }

    // post_call_transcription
    const data = event.data;
    const conversationId = data.conversation_id;
    const transcript = transcriptArrayToString(data.transcript);
    const phone =
      data.metadata?.phone_call?.external_number ||
      (data.conversation_initiation_client_data?.dynamic_variables
        ?.phone_number as string | undefined) ||
      "";

    console.log("[ELEVENLABS WEBHOOK] Received:", {
      conversationId,
      phone,
      hasTranscript: !!transcript,
      turns: data.transcript?.length ?? 0,
    });

    if (conversationId) {
      const claimed = await claimCallForProcessing(conversationId);
      if (!claimed) {
        console.log(
          "[ELEVENLABS WEBHOOK] Already processed call, skipping:",
          conversationId,
        );
        return;
      }
    }

    if (!transcript) {
      console.log("[ELEVENLABS WEBHOOK] No transcript on terminal event");
      await advanceDialerToNextLead();
      return;
    }

    const rawAnalysis = await analyzeTranscript(transcript);
    const analysis = normalizeAnalysis(rawAnalysis);

    const decision = decideNextAction(analysis.intent_score, analysis.outcome);

    const nextCallAt = resolveNextCallAt(analysis, transcript, decision.action);

    if (!phone) {
      console.error(
        "[ELEVENLABS WEBHOOK] No phone in payload — cannot match lead",
      );
      return;
    }

    const lead = await db.query.dealerLeads.findFirst({
      where: (l, { eq }) => eq(l.phone, phone),
    });

    if (!lead) {
      console.warn("[ELEVENLABS WEBHOOK] No dealer_leads row for phone:", phone);
      return;
    }

    const updatedLead = updateLeadAfterCall(
      { ...lead, follow_up_history: lead.follow_up_history || [] },
      {
        transcript,
        outcome: analysis.outcome,
        nextCallAt,
        analysis: analysis.analysis,
        conversation: data.transcript || [],
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

    if (decision.action === "schedule_call" && nextCallAt) {
      const messageId = await scheduleElevenLabsCall({
        phone,
        leadId: lead.id,
        runAt: nextCallAt,
      });
      if (!messageId) {
        // QStash quota exhausted or scheduling failed. dealer_leads.next_call_at
        // is already set above, so the elevenlabs/call-scheduler cron is the
        // recovery path. Log so quota exhaustion is visible in pm2 logs.
        console.warn(
          `[elevenlabs:webhook] scheduleElevenLabsCall returned null for ${lead.id} — relying on call-scheduler cron to recover`,
        );
      }
    }

    if (decision.action === "push_to_crm") {
      await db
        .update(dealerLeads)
        .set({ current_status: "qualified" })
        .where(eq(dealerLeads.id, lead.id));
    }

    const summary = analysis.memory?.intent_summary
      ? `${analysis.outcome} — ${analysis.memory.intent_summary}`
      : `${analysis.outcome} — Intent: ${analysis.intent_score}/100`;

    appendSalesCallLog({
      leadId: lead.id,
      timestamp: new Date(),
      direction: "outbound",
      toNumber: phone,
      fromNumber: process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID ?? "—",
      transcript,
      summary,
      convId: conversationId ?? "—",
    }).catch((err) =>
      console.error("[ELEVENLABS SHEETS] Sales call log failed:", err),
    );

    await advanceDialerToNextLead();
  } catch (err) {
    console.error("[ELEVENLABS WEBHOOK] handler error:", err);
  }
}
