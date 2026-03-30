import { analyzeTranscript } from "@/lib/ai/analysis";
import { decideNextAction } from "@/lib/ai/decision/engine";
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { updateLeadAfterCall } from "../storage/leadStore";
import { dealerLeads } from "@/lib/db/schema";
import { callQueue } from "@/lib/queue/callQueue";

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

export async function handleBolnaWebhook(body: any) {
  try {
    const { transcript, user_number: phone, status } = body;

    if (status !== "completed" || !transcript) return;

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

    if (decision.action === "schedule_call" && nextCallAt) {
      const delay = new Date(nextCallAt).getTime() - Date.now();

      await callQueue.add(
        "call-lead",
        {
          phone,
          leadId: lead.id,
        },
        {
          delay: Math.max(delay, 0),
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 5000,
          },
        },
      );

      console.log("JOB ADDED:", {
        phone,
        leadId: lead.id,
        delay,
      });
    }

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

    if (decision.action === "push_to_crm") {
      await db
        .update(dealerLeads)
        .set({ current_status: "qualified" })
        .where(eq(dealerLeads.id, lead.id));
    }
  } catch (err) {
    console.error("Webhook handler error:", err);
  }
}
