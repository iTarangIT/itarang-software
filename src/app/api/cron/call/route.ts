import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { triggerBolnaCall } from "@/lib/ai/bolna_ai/triggerCall";
import { quotaCircuit } from "@/lib/queue/connection";
import { log } from "@/lib/log";
import { eq, and } from "drizzle-orm";

const MAX_CONSECUTIVE_5XX = 3;

export async function GET() {
  const now = new Date();

  const leads = await db.query.dealerLeads.findMany({
    where: (l, { lte, isNotNull }) =>
      and(lte(l.next_call_at, now), isNotNull(l.next_call_at)),
  });

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
    bailedOn,
  });
}
