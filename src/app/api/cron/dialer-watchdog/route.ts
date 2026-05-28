// Periodic recovery for stalled AI dialer campaigns.
//
// Two failure modes this exists to repair:
//
//  1. Bolna webhook drops — a per-lead row was flipped to 'calling' but no
//     completion webhook ever arrived. Without intervention the row stays
//     in 'calling' forever and the campaign's counters never advance.
//     `sweepStalledCallingLeads` flips rows older than 4 minutes to 'failed'.
//
//  2. Whole-campaign stall — initial call placement failed, or every webhook
//     dropped, and the campaign has been "running" for hours with no rows
//     completing. Finalize as 'stopped' so the campaign card stops blinking.
//
// Idempotent: re-running this is a no-op when nothing is stalled. Safe to
// schedule aggressively (every 2 minutes in vercel.json).

import { db } from "@/lib/db";
import {
  dialerCampaigns,
  dialerCampaignLeads,
} from "@/lib/db/schema";
import {
  finalizeCampaign,
  sweepStalledCallingLeads,
} from "@/lib/queue/campaignTracker";
import { advanceCampaign } from "@/lib/queue/advanceCampaign";
import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export const maxDuration = 60;

const STALL_FINALIZE_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
const NO_PROGRESS_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export async function GET(req: Request) {
  // Vercel-style cron auth: shared bearer in CRON_SECRET. Same pattern as
  // /api/bolna/call-scheduler. Manual ad-hoc runs from localhost bypass this
  // by virtue of Vercel injecting the header on real cron firings.
  const authHeader = req.headers.get("authorization");
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const runStartedAt = new Date();
  const results: Array<{
    campaignId: string;
    swept: number;
    finalizedAs: "stopped" | null;
  }> = [];

  try {
    const running = await db
      .select({
        id: dialerCampaigns.id,
        started_at: dialerCampaigns.started_at,
      })
      .from(dialerCampaigns)
      .where(eq(dialerCampaigns.status, "running"));

    for (const c of running) {
      const swept = await sweepStalledCallingLeads(c.id);

      // If we just force-failed in-flight rows, no webhook will fire to
      // re-enter advanceCampaign — so the campaign would sit on its
      // remaining pending rows forever. Kick it forward here.
      if (swept > 0) {
        try {
          await advanceCampaign(c.id);
        } catch (err) {
          console.error(
            `[dialer-watchdog] post-sweep advance failed for ${c.id}:`,
            err,
          );
        }
      }

      // A campaign that's been running > 2h with no completed/failed row in
      // the last 10 min is dead — finalize as stopped. Treat the campaign's
      // own started_at as a fallback "last activity" timestamp when no
      // per-lead rows have completed yet.
      const campaignAgeMs =
        runStartedAt.getTime() - new Date(c.started_at).getTime();

      let finalizedAs: "stopped" | null = null;
      if (campaignAgeMs > STALL_FINALIZE_AGE_MS) {
        const lastActivity = await db
          .select({ completed_at: dialerCampaignLeads.completed_at })
          .from(dialerCampaignLeads)
          .where(
            and(
              eq(dialerCampaignLeads.campaign_id, c.id),
              // Any terminal row counts as progress for this gate.
            ),
          )
          .orderBy(desc(dialerCampaignLeads.completed_at))
          .limit(1);

        const lastCompletedAt = lastActivity[0]?.completed_at
          ? new Date(lastActivity[0].completed_at).getTime()
          : new Date(c.started_at).getTime();
        const sinceLastActivityMs = runStartedAt.getTime() - lastCompletedAt;

        if (sinceLastActivityMs > NO_PROGRESS_WINDOW_MS) {
          await finalizeCampaign(c.id, "stopped");
          finalizedAs = "stopped";
        }
      }

      results.push({ campaignId: c.id, swept, finalizedAs });
    }

    return NextResponse.json({
      success: true,
      checked: running.length,
      checked_at: runStartedAt.toISOString(),
      results,
    });
  } catch (err) {
    console.error("[dialer-watchdog] failed:", err);
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "watchdog error",
      },
      { status: 500 },
    );
  }
}
