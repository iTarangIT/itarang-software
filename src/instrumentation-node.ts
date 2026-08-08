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
import { syncInvoicesSinceLastRun } from "@/lib/zoho/sync";
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

// Zoho Invoice sync — mirrors /api/cron/zoho-sync (vercel.json, hourly at :05).
// Vercel crons don't fire on Hostinger PM2 (see docs/DEPLOY_RUNBOOK.md), so the
// zoho_invoices table never populates there and the CEO Sales Invoices page
// (/ceo/invoices) shows zeros. This in-process ticker keeps the table fresh in
// the long-lived PM2 / `npm run start` process — full re-pull + upsert keyed on
// zoho_invoice_id. On Vercel the cron entry owns this, so we short-circuit.
export async function startZohoSyncTicker() {
  // Skip on Vercel — let the cron handle it.
  if (process.env.VERCEL === "1") return;

  // Explicit opt-out (e.g. inside the BullMQ worker, which also boots
  // instrumentation, to avoid two processes full-pulling in parallel).
  if (process.env.ENABLE_ZOHO_SYNC === "0") return;

  // No credentials → nothing to sync. Stay quiet rather than logging an
  // auth error every hour on environments that don't use Zoho.
  if (
    !process.env.ZOHO_CLIENT_ID ||
    !process.env.ZOHO_CLIENT_SECRET ||
    !process.env.ZOHO_REFRESH_TOKEN ||
    !process.env.ZOHO_ORGANIZATION_ID
  ) {
    console.log(
      "[instrumentation:zoho-sync] Zoho credentials not configured — ticker disabled",
    );
    return;
  }

  const SYNC_INTERVAL_MS = 60 * 60_000; // hourly, matches vercel.json

  let inFlight = false;
  const syncTick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const r = await syncInvoicesSinceLastRun();
      console.log(
        `[instrumentation:zoho-sync] status=${r.status} upserted=${r.upserted} durationMs=${r.durationMs}`,
      );
      if (r.errors.length) {
        console.error(
          `[instrumentation:zoho-sync] partial run — ${r.errors.length} error(s): ${r.errors.join(" | ")}`,
        );
      }
    } catch (err) {
      // syncInvoicesSinceLastRun already records the failure to
      // zoho_sync_state.last_error; just surface it in the logs.
      console.error(
        "[instrumentation:zoho-sync] tick failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      inFlight = false;
    }
  };

  // Kick off shortly after boot so a freshly-deployed server populates the
  // table without waiting a full hour. Staggered behind the dialer kickoff.
  const kickoff = setTimeout(syncTick, 20_000);
  if (typeof kickoff.unref === "function") kickoff.unref();

  const interval = setInterval(syncTick, SYNC_INTERVAL_MS);
  if (typeof interval.unref === "function") interval.unref();

  console.log("[instrumentation] zoho-sync (1h) started in-process");
}

// ---------------------------------------------------------------------------
// peakAmp buyback — notification dispatch (M20).
//
// BRD §6 says "notifications via BullMQ, never inline". BullMQ is dead code in
// this repo: production declares no worker process at all, the sandbox worker is
// deliberately dormant (autorestart: false, no ENABLE_CALL_WORKER — it logs
// "disabled" and exits), and callQueue.add() is never called anywhere. Vercel
// crons do not fire on the pm2 VPS either. An in-process ticker is the only
// mechanism that demonstrably runs in BOTH sandbox and production — it is how
// the dialer above and the Zoho sync actually work.
//
// "Never inline" is still honoured, and that is the part that matters: a route
// COMMITS the event inside its transaction and returns. The send happens out
// here, so a slow mail provider can never make an admin's click hang, and a
// bounced email can never roll back a state change that really happened.
//
// dispatchPending() is the unit of work. Swapping this ticker for a real queue
// consumer later changes the caller, not the logic.
// ---------------------------------------------------------------------------
export async function startBuybackDispatchTicker() {
  const DISPATCH_INTERVAL_MS = 30_000;
  // E-192-D: 20 → 50 (dispatch.ts now sends the claimed batch in parallel
  // chunks of 5, so a bigger batch no longer means a proportionally slower
  // tick) — raises the throughput ceiling from ~2,400/hr to ~6,000/hr.
  const BATCH = 50;

  let inFlight = false;

  const tick = async () => {
    if (inFlight) return; // a slow provider must not stack ticks
    inFlight = true;
    try {
      const { dispatchPending } = await import("@/lib/buyback/dispatch");
      const r = await dispatchPending(BATCH);

      if (r.claimed > 0) {
        console.log(
          `[instrumentation:buyback-dispatch] claimed=${r.claimed} sent=${r.sent} ` +
            `failed=${r.failed} exhausted=${r.exhausted}`,
        );
      }
      if (r.exhausted > 0) {
        console.error(
          `[instrumentation:buyback-dispatch] ${r.exhausted} event(s) hit the retry ceiling ` +
            `and are marked FAILED — a dealer or vendor was NOT told something. Investigate.`,
        );
      }
    } catch (err) {
      // Never let a dispatch failure kill the ticker: the events are durable and
      // still PENDING, so the next tick retries them.
      console.error(
        "[instrumentation:buyback-dispatch] tick failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      inFlight = false;
    }
  };

  // Staggered behind the dialer (5s) and Zoho (20s) kickoffs.
  const kickoff = setTimeout(tick, 35_000);
  if (typeof kickoff.unref === "function") kickoff.unref();

  const interval = setInterval(tick, DISPATCH_INTERVAL_MS);
  if (typeof interval.unref === "function") interval.unref();

  console.log("[instrumentation] buyback-dispatch (30s) started in-process");
}

// ---------------------------------------------------------------------------
// peakAmp buyback — nightly photo dedup + the weekly price-review nudge (M03/M16).
//
// Same runtime argument as the dispatcher above: BullMQ is dead code here and
// Vercel crons do not fire on pm2, so an in-process ticker is the only mechanism
// that demonstrably runs in both sandbox and production.
//
// The dedup sweep is the one that earns its keep. It hashes new photos and flags
// any whose hash matches an EARLIER photo — and when the two photos belong to
// DIFFERENT DEALERS, that is the same battery being sold to iTarang twice. That
// flag goes straight to the admins' bell (M03 AC).
// ---------------------------------------------------------------------------
export async function startBuybackDedupTicker() {
  const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 4× a day; "nightly" with a margin
  const NUDGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

  let inFlight = false;

  const sweep = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const { runDedupSweep } = await import("@/lib/buyback/dedup");
      const r = await runDedupSweep(200);

      if (r.hashed || r.flagged) {
        console.log(
          `[instrumentation:buyback-dedup] hashed=${r.hashed} failed=${r.hashFailed} ` +
            `flagged=${r.flagged} crossDealer=${r.crossDealer}`,
        );
      }
      if (r.crossDealer > 0) {
        console.warn(
          `[instrumentation:buyback-dedup] ${r.crossDealer} photo(s) matched an upload by a ` +
            `DIFFERENT dealer — the same battery may be being sold twice. Admins notified.`,
        );
      }
    } catch (err) {
      console.error(
        "[instrumentation:buyback-dedup] sweep failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      inFlight = false;
    }
  };

  const nudge = async () => {
    try {
      const { checkPriceReviewDue } = await import("@/lib/buyback/catalog");
      await checkPriceReviewDue();
    } catch (err) {
      console.error(
        "[instrumentation:buyback-price-nudge] failed:",
        err instanceof Error ? err.message : err,
      );
    }
  };

  // M19 — poll Digio for agreements out for signature, and ACTIVATE the role of
  // anyone who has signed. This is what actually lets an entity trade: a vendor
  // whose business_entity_roles row is not ACTIVE is invisible to the routing
  // query. Polled rather than webhook-driven — see src/lib/buyback/agreement.ts
  // for why, but the short version is that a webhook which is never delivered
  // fails silently forever, and a poller catches up on its next tick.
  const AGREEMENT_INTERVAL_MS = 2 * 60 * 1000;

  const syncTick = async () => {
    try {
      const { syncAgreements } = await import("@/lib/buyback/agreement");
      const r = await syncAgreements();
      if (r.signed || r.declined) {
        console.log(
          `[instrumentation:buyback-agreements] checked=${r.checked} signed=${r.signed} declined=${r.declined}`,
        );
      }
    } catch (err) {
      console.error(
        "[instrumentation:buyback-agreements] sync failed:",
        err instanceof Error ? err.message : err,
      );
    }
  };

  const agreementInterval = setInterval(syncTick, AGREEMENT_INTERVAL_MS);
  if (typeof agreementInterval.unref === "function") agreementInterval.unref();

  // Staggered behind the dialer (5s), Zoho (20s) and dispatch (35s) kickoffs.
  const kickoff = setTimeout(sweep, 60_000);
  if (typeof kickoff.unref === "function") kickoff.unref();

  const sweepInterval = setInterval(sweep, SWEEP_INTERVAL_MS);
  if (typeof sweepInterval.unref === "function") sweepInterval.unref();

  const nudgeInterval = setInterval(nudge, NUDGE_INTERVAL_MS);
  if (typeof nudgeInterval.unref === "function") nudgeInterval.unref();

  console.log("[instrumentation] buyback-dedup (6h) + price-review nudge (24h) started in-process");
}

// ---------------------------------------------------------------------------
// peakAmp buyback — online gateway poller (E-193/R6).
//
// The backstop for RazorpayX payouts and Razorpay payment links: webhooks are the
// fast path, but a webhook that is never delivered fails silently forever. This
// ticker reconciles any in-flight attempt that has gone quiet for >10 minutes
// against its provider, so a dropped webhook self-heals on the next pass. Same
// runtime argument as the dispatcher/dedup tickers — Vercel crons do not fire on
// pm2, and this in-process ticker is the only driver besides the webhooks.
//
// DARK UNLESS CONFIGURED: with no RazorpayX vars and no payment-link flag the tick
// body returns immediately, before any DB or provider work.
// ---------------------------------------------------------------------------
export async function startBuybackGatewayTicker() {
  const TICK_INTERVAL_MS = 60_000;
  const BATCH = 20;

  let inFlight = false;

  const tick = async () => {
    if (inFlight) return; // a slow provider must not stack ticks
    inFlight = true;
    try {
      const { payoutsConfigured } = await import("@/lib/razorpayx");
      const { buybackLinksConfigured } = await import("@/lib/razorpay");
      // Neither provider configured → nothing this ticker could ever reconcile.
      if (!payoutsConfigured() && !buybackLinksConfigured()) return;

      const { sweepInflightGatewayTxns } = await import("@/lib/buyback/gateway");
      const r = await sweepInflightGatewayTxns(BATCH);
      if (r.checked > 0) {
        console.log(
          `[instrumentation:buyback-gateway] checked=${r.checked} advanced=${r.advanced} ` +
            `progressed=${r.progressed} failed=${r.failed}`,
        );
      }
    } catch (err) {
      // Never let a sweep failure kill the ticker: the rows are durable and still
      // in flight, so the next tick retries them.
      console.error(
        "[instrumentation:buyback-gateway] tick failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      inFlight = false;
    }
  };

  // Staggered behind the dialer (5s), Zoho (20s), dispatch (35s) and dedup (60s).
  const kickoff = setTimeout(tick, 45_000);
  if (typeof kickoff.unref === "function") kickoff.unref();

  const interval = setInterval(tick, TICK_INTERVAL_MS);
  if (typeof interval.unref === "function") interval.unref();

  console.log("[instrumentation] buyback-gateway poller (60s) started in-process");
}

// ---------------------------------------------------------------------------
// Ops Console — the metric collector runner (E-210).
//
// One timer, per-collector cadence. This ticks every 60s and calls
// runDueCollectors(), which executes only the collectors whose last run is
// older than their own declared intervalMs. Adding a collector therefore does
// NOT mean adding a ticker — see src/lib/operations/collectors/index.ts.
//
// Deliberately no `VERCEL === "1"` guard, unlike the dialer and Zoho tickers
// above. Those short-circuit because vercel.json declares equivalent crons; the
// Ops Console has none, and in any case production runs on pm2 where Vercel
// crons never fire. This ticker is the only thing that runs the collectors.
//
// Each tick does three things: run due collectors, evaluate thresholds, and —
// once per IST day past 00:15 — freeze yesterday into ops_daily_snapshots and
// prune. One timer for all of it; there is no second scheduler to keep alive.
// ---------------------------------------------------------------------------
export async function startOpsMonitorTicker() {
  // Explicit opt-out, e.g. for a second process that also boots
  // instrumentation and would otherwise contend for every collector's lock.
  // (Contention is safe — the partial unique index makes the loser skip — but
  // it is pointless work and noisy in ops_collector_runs.)
  if (process.env.ENABLE_OPS_MONITOR === "0") {
    console.log("[instrumentation:ops-monitor] disabled via ENABLE_OPS_MONITOR=0");
    return;
  }

  const TICK_INTERVAL_MS = 60_000;

  // Which IST day the daily rollup last ran for. In memory on purpose — see the
  // rollup block in tick() for why that is safe.
  let lastDailyDate: string | null = null;

  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const { runDueCollectors } = await import("@/lib/operations/runner");
      const outcomes = await runDueCollectors("ticker");

      if (outcomes.length > 0) {
        const ok = outcomes.filter((o) => o.status === "completed").length;
        const failed = outcomes.filter((o) => o.status === "failed");
        const samples = outcomes.reduce((sum, o) => sum + o.samples, 0);
        console.log(
          `[instrumentation:ops-monitor] ran=${outcomes.length} ok=${ok} failed=${failed.length} samples=${samples}`,
        );
        for (const f of failed) {
          console.error(
            `[instrumentation:ops-monitor] ${f.collector_id} failed: ${f.error}`,
          );
        }
      }

      // Threshold evaluation runs EVERY tick, not only when a collector fired.
      // It is cheap (one indexed read per metric) and it must not hang off
      // `outcomes.length` — the alerts it resolves are driven by samples that
      // may have landed on an earlier tick.
      const { evaluateAlerts } = await import("@/lib/operations/alerts");
      const alerts = await evaluateAlerts();
      if (alerts.opened > 0 || alerts.resolved > 0) {
        console.log(
          `[instrumentation:ops-monitor] alerts opened=${alerts.opened} ` +
            `resolved=${alerts.resolved} notified=${alerts.notified}`,
        );
      }

      // Daily rollup, once per IST day past 00:15. The last-run date is held in
      // memory: a restart just means the next tick past 00:15 redoes it, and
      // the UNIQUE(snapshot_date, metric_key, source) from E-210 makes that a
      // no-op rather than a duplicate.
      const { istDate, istHourMinute, previousIstDate, runDailySnapshot } =
        await import("@/lib/operations/daily");

      const today = istDate();
      const { hour, minute } = istHourMinute();
      // `>=` rather than `===`: a process that was down at 00:15 still catches
      // up on its first tick after boot instead of skipping the day entirely.
      if (lastDailyDate !== today && (hour > 0 || minute >= 15)) {
        const result = await runDailySnapshot(previousIstDate());
        // Stamped only on success — a failed rollup retries on the next tick.
        lastDailyDate = today;
        console.log(
          `[instrumentation:ops-monitor] daily rollup for ${result.snapshot_date}: ` +
            `${result.snapshots_written} snapshots, pruned ${result.samples_pruned} samples / ` +
            `${result.logs_pruned} logs / ${result.sessions_pruned} sessions / ` +
            `${result.login_events_pruned} login events`,
        );
      }
    } catch (err) {
      // Never let a tick failure kill the ticker — the whole point of this
      // dashboard is that it keeps reporting when other things break.
      console.error(
        "[instrumentation:ops-monitor] tick failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      inFlight = false;
    }
  };

  // Staggered behind every other ticker (5s, 20s, 35s, 45s, 60s) so a cold
  // boot does not open five collectors' worth of queries while the dialer and
  // Zoho are already competing for the same max: 5 connection pool.
  const kickoff = setTimeout(tick, 75_000);
  if (typeof kickoff.unref === "function") kickoff.unref();

  const interval = setInterval(tick, TICK_INTERVAL_MS);
  if (typeof interval.unref === "function") interval.unref();

  console.log("[instrumentation] ops-monitor (60s) started in-process");
}
