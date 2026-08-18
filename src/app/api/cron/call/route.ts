import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { triggerBolnaCall } from "@/lib/ai/bolna_ai/triggerCall";
import { quotaCircuit } from "@/lib/queue/connection";
import { log } from "@/lib/log";
import { eq, and } from "drizzle-orm";
import {
  AI_FOLLOWUP_LOOP_RETIRES_CONNECTED,
  aiDialableCondition,
} from "@/lib/ai-dialer/exclusionFilter";
import { retireAiConnectedFollowUps } from "@/lib/ai-dialer/aiConnection";

const MAX_CONSECUTIVE_5XX = 3;

export async function GET() {
  const now = new Date();

  const candidates = await db.query.dealerLeads.findMany({
    where: (l, { lte, isNotNull, isNull, ne, or }) =>
      and(
        lte(l.next_call_at, now),
        isNotNull(l.next_call_at),
        // Skip leads explicitly tagged for ElevenLabs — handled by
        // /api/elevenlabs/call-scheduler. NULL provider = legacy/Bolna.
        or(isNull(l.provider), ne(l.provider, "elevenlabs")),
        // BRD §0.2 — never call a lead in an active sales state.
        aiDialableCondition(),
      ),
  });

  // The AI-connected hard block, applied to the AI's OWN follow-up loop.
  //
  // Worth reading twice: next_call_at is written only by resolveNextCallAt() on
  // the transcript path, so EVERY lead this cron selects is AI-connected by
  // construction. Blocking here therefore does not merely "also cover" the
  // follow-up loop — it switches it off, and those dealers become Inside Sales'
  // to call. That is the intended behaviour (there is no AI follow-up
  // capability), but it is a retirement rather than a side effect, which is why
  // it sits behind a named constant.
  //
  // Clearing next_call_at is not optional: leaving it set would make this cron
  // re-select the same leads every single minute, forever.
  const { dialable: leads, retired } = await retireAiConnectedFollowUps(
    candidates,
    { enabled: AI_FOLLOWUP_LOOP_RETIRES_CONNECTED, source: "cron/call" },
  );

  let processed = 0;
  let consecutive5xx = 0;
  let bailedOn: string | null = null;

  for (const lead of leads) {
    // Circuit-breaker: bail early when Upstash quota is exhausted. Avoids
    // piling up failing webhook/dispatch calls that will be rejected anyway.
    if (quotaCircuit.tick()) {
      bailedOn = "upstash-quota";
      break;
    }
    if (consecutive5xx >= MAX_CONSECUTIVE_5XX) {
      bailedOn = "bolna-5xx";
      break;
    }
    if (!lead.phone) continue;

    log.info("[cron/call] triggering", { leadId: lead.id });

    const result = await triggerBolnaCall({
      leadId: lead.id,
      phone: lead.phone,
    });

    if (result && (result as { success?: boolean }).success === false) {
      const msg = String((result as { error?: unknown }).error ?? "");
      if (/\b5\d\d\b/.test(msg) || /server/i.test(msg)) {
        consecutive5xx += 1;
      } else {
        consecutive5xx = 0;
      }
    } else {
      consecutive5xx = 0;
    }

    await db
      .update(dealerLeads)
      .set({ next_call_at: null })
      .where(eq(dealerLeads.id, lead.id));

    processed += 1;
  }

  if (bailedOn) {
    log.warn(`[cron/call] bailed: ${bailedOn}`, { processed, totalCandidates: leads.length });
  }

  return Response.json({
    success: true,
    processed,
    totalCandidates: leads.length,
    // Leads whose AI follow-up was retired this tick because the AI had already
    // spoken to them. Surfaced so the cron output is auditable — a run that
    // silently dropped work would be indistinguishable from a quiet one.
    retiredAiConnected: retired,
    bailedOn,
  });
}
