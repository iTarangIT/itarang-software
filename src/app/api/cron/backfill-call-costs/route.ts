// GET /api/cron/backfill-call-costs
//
// Two-phase sweep, both idempotent:
//
//   Phase A — Recover MISSING ai_call_logs rows. When the upsertAiCallLog
//   step in finalize*Call throws (historically: FK drift on lead_id), the
//   campaign-lead row was already flipped to completed/failed via
//   completeCampaignLead but no ai_call_logs row landed. We can recover
//   from dialer_campaign_leads alone — it has the provider call_id and
//   the lead_id we need. Insert a minimal placeholder row that the cost
//   fetcher and analytics joins can use.
//
//   Phase B — Enrich rows with provider cost. The existing path: any
//   ai_call_logs row with cost_fetched_at = NULL whose call ended more
//   than 5 min ago gets its cost fetched from the Bolna / ElevenLabs API.
//
// Cadence: every 15 min on Vercel (vercel.json). Cache-warm to keep the
// per-tick cost low.
//
// The sweep itself lives in src/lib/ai/storage/backfillCallCosts.ts (ID 227),
// shared with the in-process ticker.

import { NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { backfillCallCosts } from "@/lib/ai/storage/backfillCallCosts";

export const maxDuration = 60;

export async function GET(req: Request) {
  // ID 130: fails closed — an unset CRON_SECRET is a 500, never an open route.
  const cronDenied = checkCronAuth(req);
  if (cronDenied) return cronDenied;

  const startedAt = new Date();
  try {
    const r = await backfillCallCosts();
    return NextResponse.json({ success: true, checked_at: startedAt.toISOString(), ...r });
  } catch (err) {
    console.error("[backfill-cost] failed:", err);
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "backfill error",
      },
      { status: 500 },
    );
  }
}
