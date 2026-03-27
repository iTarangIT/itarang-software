import { analyzeTranscript } from "@/lib/ai/analysis";
import { decideNextAction } from "@/lib/ai/decision/engine";
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { updateLeadAfterCall } from "../storage/leadStore";
import { dealerLeads } from "@/lib/db/schema";

function getValidDate(input: any): Date | null {
  if (!input) return null;
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d;
}

function normalizeAnalysis(analysis: any) {
  const safe = {
    outcome: analysis.outcome || "unknown",
    callback_time: analysis.callback_time || null,
    intent_score: Number(analysis.intent_score || 0),
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

  if (hasCallback) {
    safe.outcome = "callback_requested";
  }

  if (hasQuantity && safe.analysis.product_curiosity < 5) {
    safe.analysis.product_curiosity = 7;
  }

  if (hasCallback && safe.intent_score < 50) {
    safe.intent_score = 60;
  }

  if (hasQuantity && hasCallback && safe.intent_score < 70) {
    safe.intent_score = 75;
  }

  if (safe.intent_score < 0) safe.intent_score = 0;
  if (safe.intent_score > 100) safe.intent_score = 100;

  return safe;
}

export async function handleBolnaWebhook(body: any) {
  try {
    console.log("=================================");
    console.log("WEBHOOK HIT");
    console.log("FULL BODY:", JSON.stringify(body, null, 2));
    console.log("=================================");

    const transcript = body.transcript;
    const phone = body.user_number;
    const status = body.status;

    if (status !== "completed") return;
    if (!transcript) return;

    const rawAnalysis = await analyzeTranscript(transcript);
    const analysis = normalizeAnalysis(rawAnalysis);

    console.log("FINAL ANALYSIS:", analysis);

    const decision = decideNextAction(analysis.intent_score, analysis.outcome);

    console.log("DECISION:", decision);

    let nextCallAt: Date | null = null;

    if (decision.action === "schedule_call") {
      const parsed = getValidDate(analysis.callback_time);

      if (parsed) {
        nextCallAt = parsed;
      } else if (analysis.outcome === "callback_requested") {
        nextCallAt = new Date(Date.now() + 2 * 60 * 1000);
      }
    }

    const lead = await db.query.dealerLeads.findFirst({
      where: (l, { eq }) => eq(l.phone, phone),
    });

    if (!lead) return;

    const safeLead = {
      ...lead,
      follow_up_history: lead.follow_up_history || [],
    };

    const updatedLead = updateLeadAfterCall(safeLead, {
      transcript,
      outcome: analysis.outcome,
      nextCallAt,
      analysis: analysis.analysis,
      conversation: body.messages || [],
      memory: analysis.memory,
    });

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

    if (decision.action === "follow_up") {
      console.log("Cold lead");
    }

    if (decision.action === "stop") {
      console.log("Disqualified lead");
    }
  } catch (err) {
    console.error("Webhook handler error:", err);
  }
}
