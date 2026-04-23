import { analyzeTranscript } from "@/lib/ai/analysis";
import { decideNextAction } from "@/lib/ai/decision/engine";
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { updateLeadAfterCall } from "../storage/leadStore";
import { dealerLeads } from "@/lib/db/schema";
import { safeRedisLock } from "@/lib/queue/safeRedis";
import { dialerSession } from "@/lib/queue/dialerSession";
import { scheduleCall } from "@/lib/queue/scheduler";
import { appendSalesCallLog } from "@/lib/google/sheet";
import { triggerBolnaCall } from "./triggerCall";

const PROCESSED_CALL_TTL_SECONDS = 10 * 60;

// Cross-instance dedupe for Bolna webhooks (serverless instances don't share memory).
// Returns true if this is the first time we've seen this callId.
// When Redis is degraded (quota exhaustion) safeRedisLock returns claimed=true
// with degraded=true — we bias toward processing rather than dropping a
// terminal call event.
async function claimCallForProcessing(callId: string): Promise<boolean> {
  const { claimed } = await safeRedisLock(
    `bolna:processed-call:${callId}`,
    PROCESSED_CALL_TTL_SECONDS,
    "bolna:webhook-dedup",
  );
  return claimed;
}

function getValidDate(input: any): Date | null {
  if (!input) return null;
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d;
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
      console.log("AI DIALER: queue complete, all leads called");
      break;
    }

    const candidate = await db.query.dealerLeads.findFirst({
      where: (l, { eq }) => eq(l.id, nextLeadId),
    });

    if (candidate?.phone) {
      nextLead = candidate;
      break;
    }

    console.log("AI DIALER: skipping lead with no phone", nextLeadId);
  }

  if (nextLead) {
    console.log("AI DIALER: calling next lead", {
      id: nextLead.id,
      phone: nextLead.phone,
      remaining: await dialerSession.remaining(),
    });

    await new Promise((r) => setTimeout(r, 5000));

    await triggerBolnaCall({
      phone: nextLead.phone!,
      leadId: nextLead.id,
    });
  }
}

export async function handleBolnaWebhook(body: any) {
  try {
    const { transcript, user_number: phone, status } = body;
    const callId = body.id || body.execution_id || body.run_id || "";

    console.log("[WEBHOOK] Received:", { phone, status, callId, hasTranscript: !!transcript });

    // Statuses that mean the call is still in progress — ignore them
    const IN_PROGRESS = ["initiated", "ringing", "in-progress"];

    if (IN_PROGRESS.includes(status)) {
      return;
    }

    // Deduplicate across serverless instances: Bolna sends call-disconnected
    // then completed for the same call. Only process the first terminal event.
    if (callId) {
      const claimed = await claimCallForProcessing(callId);
      if (!claimed) {
        console.log("[WEBHOOK] Already processed call, skipping:", callId);
        return;
      }
    }

    // If no transcript (busy, failed, no-answer), skip to next lead
    if (!transcript) {
      console.log("[WEBHOOK] Call ended without conversation, status:", status);
      await advanceDialerToNextLead();
      return;
    }

    const rawAnalysis = await analyzeTranscript(transcript);
    const analysis = normalizeAnalysis(rawAnalysis);

    const decision = decideNextAction(analysis.intent_score, analysis.outcome);

    const nextCallAt = resolveNextCallAt(analysis, transcript, decision.action);

    const lead = await db.query.dealerLeads.findFirst({
      where: (l, { eq }) => eq(l.phone, phone),
    });

    if (!lead) return;

    const updatedLead = updateLeadAfterCall(
      { ...lead, follow_up_history: lead.follow_up_history || [] },
      {
        transcript,
        outcome: analysis.outcome,
        nextCallAt,
        analysis: analysis.analysis,
        conversation: body.messages || [],
        memory: analysis.memory,
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

    // Delay-based dispatch via QStash (works on Vercel serverless).
    // The daily call-scheduler cron remains as a safety net for any
    // next_call_at rows written outside this webhook flow.
    if (decision.action === "schedule_call" && nextCallAt) {
      await scheduleCall({
        phone,
        leadId: lead.id,
        runAt: nextCallAt,
      });
    }

    if (decision.action === "push_to_crm") {
      await db
        .update(dealerLeads)
        .set({ current_status: "qualified" })
        .where(eq(dealerLeads.id, lead.id));
    }

    // ── Log to Google Sheets (fire-and-forget) ──
    const summary = analysis.memory?.intent_summary
      ? `${analysis.outcome} — ${analysis.memory.intent_summary}`
      : `${analysis.outcome} — Intent: ${analysis.intent_score}/100`;

    appendSalesCallLog({
      leadId: lead.id,
      timestamp: new Date(),
      direction: "outbound",
      toNumber: phone,
      fromNumber: process.env.BOLNA_FROM_NUMBER ?? "—",
      transcript: transcript,
      summary: summary,
      convId: body.execution_id ?? body.call_id ?? "—",
    }).catch((err) =>
      console.error("[SHEETS] Sales call log failed:", err),
    );

    // ── AI Dialer: auto-call next lead when session is active ──
    await advanceDialerToNextLead();
  } catch (err) {
    console.error("Webhook handler error:", err);
  }
}
