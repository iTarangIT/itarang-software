// Node-runtime-only dialer tickers, split out of instrumentation.ts so
// webpack never compiles this file — or its Drizzle/postgres-js and
// googleapis dependency graph — for the Edge runtime. It is reached only
// through the `if (process.env.NEXT_RUNTIME === "nodejs")` branch in
// instrumentation.ts, which webpack prunes from the edge build.
//
// Two in-process tickers keep the AI dialer self-healing without needing
// a separate worker terminal:
//
//   1. dialer-poll — asks providers "is this call done?" every 30s.
//      Mirrors /api/cron/dialer-poll on Vercel.
//   2. dialer-watchdog — flips rows stuck in 'calling' beyond the 4-min
//      threshold to failed/no_webhook every 2 min. Mirrors
//      /api/cron/dialer-watchdog on Vercel. Without this, a call where
//      the provider never reports terminal status (dropped webhook,
//      stalled at ElevenLabs/Bolna) stays in 'calling' forever on dev.
//
// On Vercel: serverless functions are ephemeral and this WILL run on
// cold start but won't keep ticking; the Vercel cron entries are the
// production heartbeat. We short-circuit there to avoid burning bursty
// function lifetime.
//
// On localhost (`npm run dev`) and PM2 / `npm run start`: the Node
// process is long-lived, so the setIntervals keep ticking.

import { runDialerPollOnce } from "@/lib/ai/pollCallStatus";
import { sweepStalledCallingLeads } from "@/lib/queue/campaignTracker";
import { advanceCampaign } from "@/lib/queue/advanceCampaign";
import { db } from "@/lib/db";
import { dialerCampaigns } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function startDialerTickers() {
  // Skip on Vercel — let the crons handle it.
  // VERCEL=1 is set in every Vercel runtime environment.
  if (process.env.VERCEL === "1") return;

  // Allow explicit opt-out (e.g. inside the BullMQ worker which already
  // owns the tick) to avoid double-polling.
  if (process.env.ENABLE_DIALER_POLL === "0") return;

  const POLL_INTERVAL_MS = 30_000;
  const WATCHDOG_INTERVAL_MS = 2 * 60_000;

  let pollInFlight = false;
  let watchdogInFlight = false;

  const pollTick = async () => {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const r = await runDialerPollOnce();
      if (r.polled > 0) {
        console.log(
          `[instrumentation:dialer-poll] polled=${r.polled} finalized=${r.finalized} ` +
            `notTerminal=${r.skippedNotTerminal} errors=${r.errors}`,
        );
      }
    } catch (err) {
      console.error(
        "[instrumentation:dialer-poll] tick failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      pollInFlight = false;
    }
  };

  // Watchdog: sweep stalled 'calling' rows, then nudge each affected
  // running campaign forward. Without the post-sweep advanceCampaign,
  // a stalled row that gets force-marked 'failed' leaves the campaign
  // sitting on its remaining pending rows — no webhook will fire to
  // re-enter advanceCampaign, so it stays half-finished forever.
  const watchdogTick = async () => {
    if (watchdogInFlight) return;
    watchdogInFlight = true;
    try {
      const swept = await sweepStalledCallingLeads(null);
      if (swept > 0) {
        console.log(
          `[instrumentation:dialer-watchdog] swept ${swept} stalled calling row(s)`,
        );

        // For each running campaign, place the next pending call so the
        // queue resumes. advanceCampaign is idempotent and self-skips
        // when there's nothing pending.
        const running = await db
          .select({ id: dialerCampaigns.id })
          .from(dialerCampaigns)
          .where(eq(dialerCampaigns.status, "running"));
        for (const c of running) {
          try {
            await advanceCampaign(c.id);
          } catch (err) {
            console.error(
              `[instrumentation:dialer-watchdog] post-sweep advance failed for ${c.id}:`,
              err instanceof Error ? err.message : err,
            );
          }
        }
      }
    } catch (err) {
      console.error(
        "[instrumentation:dialer-watchdog] tick failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      watchdogInFlight = false;
    }
  };

  // Initial kick after a short delay so a freshly-booted server reconciles
  // any leftover 'calling' rows from a prior process.
  const kickoff = setTimeout(() => {
    pollTick();
    watchdogTick();
  }, 5_000);
  if (typeof kickoff.unref === "function") kickoff.unref();

  const pollInterval = setInterval(pollTick, POLL_INTERVAL_MS);
  if (typeof pollInterval.unref === "function") pollInterval.unref();

  const watchdogInterval = setInterval(watchdogTick, WATCHDOG_INTERVAL_MS);
  if (typeof watchdogInterval.unref === "function") {
    watchdogInterval.unref();
  }

  console.log(
    "[instrumentation] dialer-poll (30s) + dialer-watchdog (2m) started in-process",
  );
}
