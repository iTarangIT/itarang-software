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
import { runCampaignWindowTick } from "@/lib/queue/resumeCampaigns";
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
  // E-254 — how promptly a campaign crosses a window boundary. 60s means a
  // campaign scheduled for 11:00 places its first call by 11:01 at the latest,
  // and one whose window closes at 15:00 reads as Paused by 15:01. That is the
  // resolution a business-hours window is specified at anyway.
  const WINDOW_INTERVAL_MS = 60_000;

  let pollInFlight = false;
  let watchdogInFlight = false;
  let resumeInFlight = false;

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


  // E-254 — the calling-window ticker. Two halves, both load-bearing:
  //
  //   park   — a campaign whose window just closed is parked HERE rather than
  //            waiting for a call-completion webhook that may never come. It is
  //            what makes "pause at the end time" an event instead of a side
  //            effect, and it is the only thing that rescues a campaign left
  //            'running' by an advance that arranged no re-entry.
  //   resume — a campaign whose window just opened is claimed back. This is
  //            what makes a recurring campaign multi-day.
  //
  // Both live in lib/queue/resumeCampaigns.ts so this and
  // /api/cron/campaign-resume run identical statements.
  const windowTick = async () => {
    if (resumeInFlight) return;
    resumeInFlight = true;
    try {
      const { parked, resumed } = await runCampaignWindowTick();
      if (parked.length > 0) {
        console.log(
          `[instrumentation:campaign-window] window closed on ${parked.length} campaign(s)`,
        );
      }
      if (resumed.length > 0) {
        console.log(
          `[instrumentation:campaign-window] window opened for ${resumed.length} campaign(s)`,
        );
      }
    } catch (err) {
      console.error(
        "[instrumentation:campaign-window] tick failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      resumeInFlight = false;
    }
  };

  // Initial kick after a short delay so a freshly-booted server reconciles
  // any leftover 'calling' rows from a prior process — and so a campaign whose
  // window opened while the process was down starts without waiting a full
  // interval. E-228 stores resume_after on the row precisely so a restart
  // mid-pause is a non-event: the state is on disk, not in this process.
  const kickoff = setTimeout(() => {
    pollTick();
    watchdogTick();
    windowTick();
  }, 5_000);
  if (typeof kickoff.unref === "function") kickoff.unref();

  const pollInterval = setInterval(pollTick, POLL_INTERVAL_MS);
  if (typeof pollInterval.unref === "function") pollInterval.unref();

  const watchdogInterval = setInterval(watchdogTick, WATCHDOG_INTERVAL_MS);
  if (typeof watchdogInterval.unref === "function") {
    watchdogInterval.unref();
  }

  // Its own opt-out, separate from ENABLE_DIALER_POLL: a deployment may want to
  // silence the status poll without also freezing every scheduled campaign.
  if (process.env.ENABLE_CAMPAIGN_RESUME !== "0") {
    const windowInterval = setInterval(windowTick, WINDOW_INTERVAL_MS);
    if (typeof windowInterval.unref === "function") windowInterval.unref();
  }

  console.log(
    "[instrumentation] dialer-poll (30s) + dialer-watchdog (2m) + campaign-window (60s) started in-process",
  );
}

// Zoho Invoice sync — mirrors /api/cron/zoho-sync (vercel.json, hourly at :05).
// Vercel crons don't fire on Hostinger PM2 (see docs/DEPLOY_RUNBOOK.md), so the
// zoho_invoices table never populates there and the CEO Sales Invoices page
// (/ceo/invoices) shows zeros. This in-process ticker keeps the table fresh in
// the long-lived PM2 / `npm run start` process — full re-pull + upsert keyed on
// zoho_invoice_id. On Vercel the cron entry owns this, so we short-circuit.
// Why the Zoho ticker would refuse to start, or null if it will run.
//
// Deliberately kept in agreement with assertConfigured() in lib/zoho/client.ts:
// the two USED to disagree about the org var. This guard demanded
// ZOHO_ORGANIZATION_ID while the client accepts either that or the
// comma-separated ZOHO_ORGANIZATION_IDS — so an env configured the multi-org
// way (precisely what you write when fixing "we only see one org", and what the
// prod runbook now tells you to add) disabled this ticker while every other
// Zoho path still reported itself healthy.
//
// That failure mode is the expensive one: a sync that never RUNS looks exactly
// like a sync that runs and finds nothing — a stale dashboard and no error
// anywhere. Hence the reason string, which the caller logs verbatim.
export function zohoTickerDisabledReason(
  env: Record<string, string | undefined> = process.env,
): string | null {
  // Skip on Vercel — the cron entry owns it there.
  if (env.VERCEL === "1") return "running on Vercel — the cron entry owns this";

  // Explicit opt-out (e.g. inside the BullMQ worker, which also boots
  // instrumentation, to avoid two processes full-pulling in parallel).
  if (env.ENABLE_ZOHO_SYNC === "0") return "ENABLE_ZOHO_SYNC=0";

  const missing = [
    "ZOHO_CLIENT_ID",
    "ZOHO_CLIENT_SECRET",
    "ZOHO_REFRESH_TOKEN",
  ].filter((k) => !env[k]);
  if (!env.ZOHO_ORGANIZATION_ID && !env.ZOHO_ORGANIZATION_IDS) {
    missing.push("ZOHO_ORGANIZATION_ID (or ZOHO_ORGANIZATION_IDS)");
  }

  return missing.length ? `missing ${missing.join(", ")}` : null;
}

export async function startZohoSyncTicker() {
  const disabled = zohoTickerDisabledReason();
  if (disabled) {
    // Always say WHY. The old message claimed "credentials not configured" even
    // when the real cause was an opt-out flag or a single missing var, which
    // sent debugging at the token instead of at the env.
    console.log(`[instrumentation:zoho-sync] ticker disabled — ${disabled}`);
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
// E-216 — Google Drive expense scan.
//
// Mirrors /api/cron/drive-expenses. Same reasoning as the Zoho ticker above:
// Vercel crons do not fire on the Hostinger PM2 boxes, so without this the
// scanner would only ever run when somebody remembered to press "Scan now" —
// which defeats the point of scanning a folder people drop invoices into.
//
// The work is deliberately capped per tick (DRIVE_EXPENSE_MAX_FILES_PER_RUN,
// default 25). Each new file costs a download plus one GPT-4o call, so a first
// scan of a folder holding two years of invoices must not try to finish in one
// pass. It doesn't need to: "already processed" is a property of the file (its
// md5 recorded in drive_expense_files), not of the run, so each tick simply
// picks up where the last one stopped.
// ---------------------------------------------------------------------------
export async function startDriveExpenseTicker() {
  // Skip on Vercel — the cron entry owns it there.
  if (process.env.VERCEL === "1") return;

  // Explicit opt-out, e.g. to stop a second process double-scanning.
  if (process.env.ENABLE_DRIVE_EXPENSE_SCAN === "0") return;

  // No service-account credentials → nothing to scan. Say so once at boot
  // rather than failing silently every six hours.
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    console.log(
      "[instrumentation:drive-expenses] Google service account not configured — ticker disabled",
    );
    return;
  }

  const SCAN_INTERVAL_MS =
    Number(process.env.DRIVE_EXPENSE_SCAN_INTERVAL_MS || "") || 6 * 60 * 60_000;
  const MAX_FILES = Number(process.env.DRIVE_EXPENSE_MAX_FILES_PER_RUN || "") || 25;

  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      // Imported inside the tick so the boot path stays light and the
      // googleapis graph is never pulled into the Edge compile.
      const { runDriveScan } = await import("@/lib/expenses/driveScan");
      const r = await runDriveScan({ triggeredBy: null, maxFiles: MAX_FILES });

      // Log only when something actually happened — a quiet folder should not
      // write a line every six hours forever.
      if (r.status === "skipped") {
        if (r.skipped_reason) {
          console.log(`[instrumentation:drive-expenses] skipped — ${r.skipped_reason}`);
        }
      } else if (r.files_new > 0 || r.failed > 0 || r.status === "failed") {
        console.log(
          `[instrumentation:drive-expenses] status=${r.status} seen=${r.files_seen} ` +
            `new=${r.files_new} imported=${r.imported} duplicate=${r.skipped_duplicate} ` +
            `attention=${r.needs_attention} unsupported=${r.unsupported} failed=${r.failed} ` +
            `durationMs=${r.duration_ms}`,
        );
      }
      if (r.error) {
        console.error(`[instrumentation:drive-expenses] run failed: ${r.error}`);
      }
    } catch (err) {
      // runDriveScan records its own failure to drive_scan_runs; surface it.
      console.error(
        "[instrumentation:drive-expenses] tick failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      inFlight = false;
    }
  };

  // Staggered behind dialer (5s), Zoho (20s), dispatch (35s), gateway (45s)
  // and dedup (60s), so a cold boot doesn't fire six jobs at once.
  const kickoff = setTimeout(tick, 90_000);
  if (typeof kickoff.unref === "function") kickoff.unref();

  const interval = setInterval(tick, SCAN_INTERVAL_MS);
  if (typeof interval.unref === "function") interval.unref();

  console.log(
    `[instrumentation] drive-expense-scan (${Math.round(
      SCAN_INTERVAL_MS / 60_000,
    )}m) started in-process`,
  );
}

// ---------------------------------------------------------------------------
// E-230 — OEM reference price sweep.
//
// Warns Admin and CEO before a price's validity window closes, and reminds them
// about models that have no price in force at all.
//
// An in-process ticker for the same reason as the Zoho and Drive ones above:
// Vercel crons do not fire on the PM2 boxes, and there is no other driver. It
// matters more here than it looks, because the thing being watched is invisible
// when it goes wrong — a lapsed reference price throws no error and turns
// nothing red; every quotation for that model just silently starts going to the
// CEO for approval. Nobody discovers that by watching logs.
//
// Six-hourly rather than daily so a box restarted each evening still gets a
// pass in. Re-running is cheap and safe: the expiry half is stamped per price
// line and the backlog half is behind a one-week cooldown, so extra ticks
// notify nobody twice.
// ---------------------------------------------------------------------------
export async function startOemPriceSweepTicker() {
  // Skip on Vercel — a cron entry would own it there.
  if (process.env.VERCEL === "1") return;

  // Explicit opt-out, e.g. to stop a second process double-notifying.
  if (process.env.ENABLE_OEM_PRICE_SWEEP === "0") return;

  const SWEEP_INTERVAL_MS =
    Number(process.env.OEM_PRICE_SWEEP_INTERVAL_MS || "") || 6 * 60 * 60_000;
  const WARN_DAYS = Number(process.env.OEM_PRICE_WARN_DAYS || "") || 14;

  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      // Imported inside the tick so the boot path stays light and the Drizzle
      // graph is never pulled into the Edge compile.
      const { runOemPriceSweep } = await import("@/lib/leads/oemPriceSweep");
      const r = await runOemPriceSweep({ warnDays: WARN_DAYS });

      // Log only when something happened. A fully-priced register should not
      // write a line every six hours forever.
      if (r.expiring > 0 || r.missing_notified) {
        console.log(
          `[instrumentation:oem-price-sweep] warned=${r.expiring} ` +
            `covered=${r.expiring_covered} missing=${r.missing} ` +
            `lapsed=${r.missing_lapsed} missingNotified=${r.missing_notified}`,
        );
      }
      if (r.error) {
        console.error(`[instrumentation:oem-price-sweep] sweep failed: ${r.error}`);
      }
    } catch (err) {
      // runOemPriceSweep already swallows its own failures; this catches the
      // import itself (e.g. a DB with no E-230 columns) so a broken sweep can
      // never take the ticker, or the boot, down with it.
      console.error(
        "[instrumentation:oem-price-sweep] tick failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      inFlight = false;
    }
  };

  // Last in the staggered kickoff queue — dialer (5s), Zoho (20s), dispatch
  // (35s), gateway (45s), dedup (60s), drive (90s). Nothing here is urgent to
  // the minute.
  const kickoff = setTimeout(tick, 120_000);
  if (typeof kickoff.unref === "function") kickoff.unref();

  const interval = setInterval(tick, SWEEP_INTERVAL_MS);
  if (typeof interval.unref === "function") interval.unref();

  console.log(
    `[instrumentation] oem-price-sweep (${Math.round(
      SWEEP_INTERVAL_MS / 60_000,
    )}m, ${WARN_DAYS}d notice) started in-process`,
  );
}

// ---------------------------------------------------------------------------
// Battery auction — open scheduled lots, close elapsed ones, pick winners.
// ---------------------------------------------------------------------------
// [E-234] The Battery Auction BRD calls for a BullMQ repeatable job. BullMQ is
// dead code here: `callQueue.add()` is never invoked, ecosystem.prod.config.js
// declares no worker process at all, and the sandbox worker is deliberately
// dormant (autorestart:false, after a 1136-restart loop). Vercel crons do not
// fire on the pm2 VPS either. An in-process ticker is the only mechanism that
// demonstrably runs in BOTH environments — the same conclusion, for the same
// reasons, as startBuybackDispatchTicker above.
//
// 15s, because the shortest legal auction window is 2 HOURS and the anti-snipe
// extension is 120s. A lot must not sit visibly "live" past its deadline for
// longer than a bidder would notice, and 15s is comfortably inside that while
// costing one cheap indexed query per tick (auction_lots_open_due_idx and
// auction_lots_close_due_idx are both partial, so they only cover the handful
// of lots actually in play).
export async function startAuctionTicker() {
  const TICK_INTERVAL_MS = 15_000;

  let inFlight = false;

  const tick = async () => {
    if (inFlight) return; // a slow tick must not stack
    inFlight = true;
    try {
      const { runAuctionTick } = await import("@/lib/nbfc/auction/scheduler");
      const r = await runAuctionTick();

      if (r.opened.length > 0 || r.closed.length > 0) {
        console.log(
          `[instrumentation:auction] opened=${r.opened.length} closed=${r.closed.length}` +
            (r.closed.length > 0
              ? ` (${r.closed
                  .map(
                    (c) =>
                      `${c.lot_code}:${c.winning_amount ?? "no-bid"}${c.reserve_met ? "" : " RESERVE-NOT-MET"}`,
                  )
                  .join(", ")})`
              : ""),
        );
      }

      // [E-234] The publish fan-out. Logged only when it did something, and
      // `failed` is called out separately from `skipped`: a skip is a dealer
      // with no email or the SMS gate being closed (expected), a failure is a
      // provider that rejected us (not).
      for (const f of r.fanned_out) {
        console.log(
          `[instrumentation:auction] ${f.lot_code} announced to ${f.dealers} dealer(s): ` +
            `sent=${f.sent} failed=${f.failed} skipped=${f.skipped}` +
            (f.remaining > 0 ? ` — ${f.remaining} dealer(s) still queued` : ""),
        );
      }

      // A lot that closed with bids but created no settlement is the one
      // outcome that needs a human: the money is agreed and nothing recorded
      // it. Loud, because it is silent everywhere else.
      const stuck = r.closed.filter(
        (c) => c.winning_bid_id !== null && c.reserve_met && !c.settlement_created,
      );
      if (stuck.length > 0) {
        console.error(
          `[instrumentation:auction] ${stuck.length} lot(s) closed with a winning bid but NO settlement ` +
            `(${stuck.map((c) => c.lot_code).join(", ")}) — most likely seller_tenant_id is null on a ` +
            `pre-E-232 lot. Investigate.`,
        );
      }
    } catch (err) {
      // Never let one bad tick kill the ticker — the lots are still in the
      // table and the next tick retries them.
      console.error(
        "[instrumentation:auction] tick failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      inFlight = false;
    }
  };

  // Staggered behind the dialer (5s), Zoho (20s) and buyback-dispatch (35s).
  const kickoff = setTimeout(tick, 45_000);
  if (typeof kickoff.unref === "function") kickoff.unref();

  const interval = setInterval(tick, TICK_INTERVAL_MS);
  if (typeof interval.unref === "function") interval.unref();

  console.log("[instrumentation] auction scheduler (15s) started in-process");
}

// ---------------------------------------------------------------------------
// Scraper batch queue — drain scraper_job_queue one job at a time.
// ---------------------------------------------------------------------------
// [E-241] This is the only thing that makes a batch move. A submission writes
// N rows to scraper_job_queue and returns; nothing else in the system would
// ever look at them again. Same reasoning as startAuctionTicker above and for
// the same three reasons: BullMQ is dead code here (`callQueue.add()` is never
// invoked and the sandbox worker is deliberately dormant), Vercel crons do not
// fire on the pm2 boxes, and an in-process ticker demonstrably runs in both.
//
// It is also what makes "recurring" work. A daily-window batch is not a
// schedule the app remembers — it is a pile of queued rows plus this tick
// asking, every 30 seconds, whether the window happens to be open right now. So
// the queue survives a pm2 restart, a deploy, and the end of the working day
// with no state to restore: the rows are on disk and the clock is Postgres's.
//
// 30s because the work behind one tick is one indexed claim query against a
// partial index (idx_scraper_job_queue_claim WHERE status='queued') plus a
// reconcile join, and the thing being waited for is a scrape that takes
// minutes. Ticking faster would only find the same run still running.
//
// runQueueTick() starts AT MOST ONE job and only when no run is in flight, so
// this cannot stack work no matter how long a scrape takes — the strictly
// serial behaviour the batch feature was specified with.
export async function startScraperQueueTicker() {
  // Skip on Vercel — a cron entry in vercel.json would own it there, and
  // /api/cron/scraper-queue/tick exists for exactly that.
  if (process.env.VERCEL === "1") return;

  // Explicit opt-out, e.g. to stop a second process competing. (It would not
  // corrupt anything — the FOR UPDATE SKIP LOCKED claim is the real guard —
  // but one draining process is easier to reason about in logs.)
  if (process.env.ENABLE_SCRAPER_QUEUE === "0") return;

  const TICK_INTERVAL_MS =
    Number(process.env.SCRAPER_QUEUE_INTERVAL_MS || "") || 30_000;

  let inFlight = false;

  const tick = async () => {
    if (inFlight) return; // a slow dispatch must not stack ticks
    inFlight = true;
    try {
      const { runQueueTick } = await import("@/lib/scraper/jobQueue");
      const r = await runQueueTick();

      // Log only when something happened. An empty queue is the steady state
      // and must not write a line every 30 seconds forever.
      if (r.dispatched) {
        console.log(
          `[instrumentation:scraper-queue] dispatched job ${r.dispatched.jobId} as run ${r.dispatched.runId}` +
            (r.reconciled > 0 ? ` (reconciled ${r.reconciled})` : ""),
        );
      }
    } catch (err) {
      // Never let one bad tick kill the ticker — the jobs are still queued and
      // the next tick retries them. The most likely cause by far is a database
      // without E-241, where every tick throws "relation scraper_job_queue does
      // not exist" and the pre-existing single-query scraper carries on fine.
      console.error(
        "[instrumentation:scraper-queue] tick failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      inFlight = false;
    }
  };

  // Last in the staggered kickoff queue — dialer (5s), Zoho (20s), dispatch
  // (35s), gateway (45s), auction (45s), dedup (60s), drive (90s), oem-price
  // (120s). Nothing here is urgent to the minute and a batch that waits an
  // extra two minutes on boot is indistinguishable from one that did not.
  const kickoff = setTimeout(tick, 135_000);
  if (typeof kickoff.unref === "function") kickoff.unref();

  const interval = setInterval(tick, TICK_INTERVAL_MS);
  if (typeof interval.unref === "function") interval.unref();

  console.log(
    `[instrumentation] scraper batch queue (${Math.round(
      TICK_INTERVAL_MS / 1000,
    )}s, serial) started in-process`,
  );
}

// ---------------------------------------------------------------------------
// KYC auto-approval SLA sweep — approve cases no admin acted on in time.
// ---------------------------------------------------------------------------
// [E-246] This is the only thing that makes the SLA expire. `submit-verification`
// stamps `admin_verification_queue.sla_due_at` and returns; without this tick
// the deadline is a column nobody reads. Same reasoning as startAuctionTicker
// and startScraperQueueTicker, and for the same three reasons: BullMQ is dead
// code here, the crons in vercel.json do not fire on the pm2 boxes, and an
// in-process ticker demonstrably runs in both environments.
//
// 60s because the unit being waited for is hours. The claim behind one tick is
// a single indexed UPDATE against a partial index
// (admin_verification_queue_sla_due_idx WHERE auto_approved_at IS NULL AND
// status='pending_itarang_verification'), so an idle tick is nearly free, and a
// case auto-approving up to a minute after its deadline is indistinguishable
// from one that did not.
//
// runKycAutoApprovalTick() returns immediately when the feature is disabled,
// which is the shipped default — so this ticker is inert until an admin turns
// it on at /admin/settings → KYC Automation.
export async function startKycAutoApprovalTicker() {
  // Skip on Vercel — /api/cron/kyc-auto-approval owns it there.
  if (process.env.VERCEL === "1") return;

  const TICK_INTERVAL_MS = 60_000;

  let inFlight = false;

  const tick = async () => {
    if (inFlight) return; // a slow tick must not stack
    inFlight = true;
    try {
      const { runKycAutoApprovalTick } = await import("@/lib/kyc/auto-approval");
      await runKycAutoApprovalTick();
      // The tick logs its own counts when it did something; a quiet tick — the
      // overwhelmingly common case — says nothing.
    } catch (err) {
      // Never let one bad tick kill the ticker. The likeliest cause is a
      // database without E-246, where every tick throws "column sla_due_at does
      // not exist" and the manual KYC review carries on untouched.
      console.error(
        "[instrumentation:kyc-auto-approval] tick failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      inFlight = false;
    }
  };

  // Behind the scraper queue (135s) in the staggered kickoff — nothing here is
  // urgent to the minute and a case whose SLA expired hours ago can wait for
  // boot to settle.
  const kickoff = setTimeout(tick, 150_000);
  if (typeof kickoff.unref === "function") kickoff.unref();

  const interval = setInterval(tick, TICK_INTERVAL_MS);
  if (typeof interval.unref === "function") interval.unref();

  console.log("[instrumentation] KYC auto-approval SLA sweep (60s) started in-process");
}

// ---------------------------------------------------------------------------
// NBFC request SLA sweep — route NBFC document requests no admin acted on.
// ---------------------------------------------------------------------------
// [E-257] Same shape and same reasoning as startKycAutoApprovalTicker directly
// above: the write path stamps `nbfc_doc_requests.sla_due_at` /
// `nbfc_document_verifications.sla_due_at` and returns; without this tick the
// deadline is a column nobody reads. 60s because the windows are minutes to
// days, and an idle tick is three cheap claims against partial indexes.
//
// runNbfcRequestSlaTick() returns immediately when the feature is disabled,
// which is the shipped default — inert until an admin turns it on at
// /admin/settings/nbfc-request-sla.
export async function startNbfcRequestSlaTicker() {
  // Skip on Vercel — /api/cron/nbfc-request-sla owns it there.
  if (process.env.VERCEL === "1") return;

  const TICK_INTERVAL_MS = 60_000;

  let inFlight = false;

  const tick = async () => {
    if (inFlight) return; // a slow tick must not stack
    inFlight = true;
    try {
      const { runNbfcRequestSlaTick } = await import("@/lib/nbfc/request-sla");
      await runNbfcRequestSlaTick();
    } catch (err) {
      // Never let one bad tick kill the ticker. The likeliest cause is a
      // database without E-257, where every tick throws "column sla_due_at
      // does not exist" and the manual NBFC Actions card carries on untouched.
      console.error(
        "[instrumentation:nbfc-request-sla] tick failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      inFlight = false;
    }
  };

  // Behind the KYC auto-approval sweep (150s) in the staggered kickoff.
  const kickoff = setTimeout(tick, 165_000);
  if (typeof kickoff.unref === "function") kickoff.unref();

  const interval = setInterval(tick, TICK_INTERVAL_MS);
  if (typeof interval.unref === "function") interval.unref();

  console.log("[instrumentation] NBFC request SLA sweep (60s) started in-process");
}

/**
 * Drain the attached-recording transcription queue.
 *
 * WHY AN IN-PROCESS TICKER AND NOT BullMQ
 *   The verdict is already recorded near the top of this file: BullMQ is dead
 *   code here (no worker in production, a deliberately dormant one in sandbox,
 *   callQueue.add() never called), and Vercel crons do not fire on the pm2 VPS.
 *   A ticker is the only mechanism that demonstrably runs in BOTH environments.
 *
 * WHY THE INTERVAL IS SHORTER THAN THE OTHERS
 *   Every other ticker here services background bookkeeping nobody is waiting
 *   on. This one services a person who just uploaded a recording and is
 *   watching a spinner. 15 seconds keeps that wait honest without meaningfully
 *   adding load — the claim query is a partial-index probe that matches nothing
 *   when the queue is empty, which is almost always.
 */
export async function startRecordingTranscriptionTicker() {
  // A cron entry would own it on Vercel.
  if (process.env.VERCEL === "1") return;

  // Explicit opt-out. Worth having: transcription is the one ticker in this
  // file that spends money per item, so an operator needs a way to stop it
  // without a deploy.
  if (process.env.ENABLE_RECORDING_TRANSCRIPTION === "0") return;

  const TICK_INTERVAL_MS =
    Number(process.env.RECORDING_TRANSCRIPTION_INTERVAL_MS || "") || 15_000;

  let inFlight = false;
  let tickCount = 0;

  const tick = async () => {
    // A 25 MB transcription can take the better part of a minute; without this
    // the 15s interval would stack four concurrent batches on one slow file.
    if (inFlight) return;
    inFlight = true;
    try {
      const { runTranscriptionTick, reapStuckRecordings } = await import(
        "@/lib/ai/transcription/recordingQueue"
      );

      // Free rows whose process died mid-transcription. Only occasionally —
      // it is a full-predicate scan and a pm2 restart is a rare event, but
      // without it a row killed mid-claim stays 'running' forever and shows
      // the reviewer a spinner that never resolves.
      if (tickCount % 20 === 0) {
        const reaped = await reapStuckRecordings();
        if (reaped > 0) {
          console.log(
            `[instrumentation:transcription] requeued ${reaped} interrupted recording(s)`,
          );
        }
      }
      tickCount += 1;

      const processed = await runTranscriptionTick();

      // Log only when something happened. An empty queue is the steady state
      // and must not write a line every 15 seconds forever.
      if (processed > 0) {
        console.log(
          `[instrumentation:transcription] processed ${processed} recording(s)`,
        );
      }
    } catch (err) {
      // Never let one bad tick kill the ticker. The likeliest cause by far is a
      // database without E-250, where every tick throws "relation
      // lead_call_recordings does not exist" — and everything else in the CRM,
      // including the AI dialer, carries on unaffected.
      console.error(
        "[instrumentation:transcription] tick failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      inFlight = false;
    }
  };

  // Staggered kickoff, after the scraper queue (135s) so boot is not a
  // thundering herd. Nothing here is urgent to the second on startup.
  const kickoff = setTimeout(tick, 150_000);
  if (typeof kickoff.unref === "function") kickoff.unref();

  const interval = setInterval(tick, TICK_INTERVAL_MS);
  if (typeof interval.unref === "function") interval.unref();

  console.log(
    `[instrumentation] recording transcription (${Math.round(
      TICK_INTERVAL_MS / 1000,
    )}s) started in-process`,
  );
}

// ---------------------------------------------------------------------------
// Google Drive mirror — back up every S3 object to Drive (E-255).
// ---------------------------------------------------------------------------
// The upload path (s3.ts → drive-mirror.ts) tries the Drive copy inline right
// after each S3 write; this ticker drains whatever that could not finish —
// rows written while the feature was off, uploads that failed on quota or a
// Google outage, presigned browser PUTs that never touched the server — and,
// every six hours, lists the S3 bucket to enqueue anything with no ledger row
// at all (the pre-existing corpus, and a safety net for missed hooks).
//
// runDriveMirrorTick() returns immediately while the feature is disabled,
// which is the shipped default — inert until an admin turns it on at
// /admin/settings/gdrive-mirror.
export async function startDriveMirrorTicker() {
  // Skip on Vercel — /api/cron/gdrive-mirror owns it there.
  if (process.env.VERCEL === "1") return;
  if (process.env.ENABLE_GDRIVE_MIRROR_TICKER === "0") return;

  const TICK_INTERVAL_MS = 60_000;
  const BACKFILL_EVERY_MS =
    Number(process.env.GDRIVE_MIRROR_BACKFILL_INTERVAL_MS || "") || 6 * 60 * 60_000;
  const MAX_PER_TICK = Number(process.env.GDRIVE_MIRROR_MAX_PER_TICK || "") || 25;

  let inFlight = false;
  let lastBackfillAt = 0;

  const tick = async () => {
    if (inFlight) return; // a slow tick must not stack
    inFlight = true;
    try {
      const { runDriveMirrorTick, runDriveMirrorBackfill } = await import(
        "@/lib/storage/drive-mirror"
      );
      const first = await runDriveMirrorTick({ max: MAX_PER_TICK, timeBudgetMs: 50_000 });
      if (first.skipped_reason) {
        // Disabled / unconfigured — nothing else to do this tick, and no
        // backfill either (the ledger would only pile up rows nobody drains).
        return;
      }
      if (first.done > 0 || first.failed > 0 || first.missing > 0) {
        console.log(
          `[instrumentation:gdrive-mirror] claimed=${first.claimed} done=${first.done} ` +
            `failed=${first.failed} missing=${first.missing} durationMs=${first.duration_ms}`,
        );
      }
      const now = Date.now();
      if (now - lastBackfillAt >= BACKFILL_EVERY_MS) {
        lastBackfillAt = now;
        const b = await runDriveMirrorBackfill();
        if (b.enqueued > 0) {
          console.log(
            `[instrumentation:gdrive-mirror] backfill listed=${b.listed} enqueued=${b.enqueued} durationMs=${b.duration_ms}`,
          );
        }
      }
    } catch (err) {
      // Never let one bad tick kill the ticker. The likeliest cause is a
      // database without E-255 ("relation storage_drive_mirror does not
      // exist"); uploads to S3 carry on untouched either way.
      console.error(
        "[instrumentation:gdrive-mirror] tick failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      inFlight = false;
    }
  };

  // Behind the NBFC request SLA sweep (165s) in the staggered kickoff.
  const kickoff = setTimeout(tick, 180_000);
  if (typeof kickoff.unref === "function") kickoff.unref();

  const interval = setInterval(tick, TICK_INTERVAL_MS);
  if (typeof interval.unref === "function") interval.unref();

  console.log("[instrumentation] Google Drive mirror sweep (60s) started in-process");
}

// ---------------------------------------------------------------------------
// E-280 — Google Drive sales-invoice scan.
//
// The revenue-side twin of startDriveExpenseTicker above. The company moved off
// Zoho onto Vyapar, which has no API, so sales invoices now arrive only as PDFs
// filed in Drive; without this the CEO's revenue figure stops moving.
//
// This is the mechanism that actually runs. Vercel crons do not fire on the
// Hostinger PM2 boxes, so /api/cron/drive-sales is the secondary path (VPS
// crontab) and this is the primary one.
//
// Concurrency is handled inside runSalesScan by a DB `running` row scoped to
// sales runs, so this tick, the admin button and the cron route cannot
// double-import — and a sales scan does not block an expense scan, since the
// two read disjoint folders and write different tables.
// ---------------------------------------------------------------------------
export async function startDriveSalesTicker() {
  // Skip on Vercel — the cron entry owns it there.
  if (process.env.VERCEL === "1") return;

  // Explicit opt-out, e.g. to stop a second process double-scanning.
  if (process.env.ENABLE_DRIVE_SALES_SCAN === "0") return;

  // No service-account credentials → nothing to scan. Say so once at boot
  // rather than failing silently every six hours.
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    console.log(
      "[instrumentation:drive-sales] Google service account not configured — ticker disabled",
    );
    return;
  }

  const SCAN_INTERVAL_MS =
    Number(process.env.DRIVE_SALES_SCAN_INTERVAL_MS || "") || 6 * 60 * 60_000;
  const MAX_FILES = Number(process.env.DRIVE_SALES_MAX_FILES_PER_RUN || "") || 25;

  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      // Imported inside the tick so the boot path stays light and the
      // googleapis graph is never pulled into the Edge compile.
      const { runSalesScan } = await import("@/lib/sales/driveSalesScan");
      const r = await runSalesScan({ triggeredBy: null, maxFiles: MAX_FILES });

      // Log only when something actually happened — a quiet folder should not
      // write a line every six hours forever.
      if (r.status === "skipped") {
        if (r.skipped_reason) {
          console.log(`[instrumentation:drive-sales] skipped — ${r.skipped_reason}`);
        }
      } else if (r.files_new > 0 || r.failed > 0 || r.status === "failed") {
        console.log(
          `[instrumentation:drive-sales] status=${r.status} seen=${r.files_seen} ` +
            `new=${r.files_new} imported=${r.imported} duplicate=${r.skipped_duplicate} ` +
            `attention=${r.needs_attention} unsupported=${r.unsupported} failed=${r.failed} ` +
            `durationMs=${r.duration_ms}`,
        );
      }
      if (r.error) {
        console.error(`[instrumentation:drive-sales] run failed: ${r.error}`);
      }
    } catch (err) {
      // runSalesScan records its own failure to sales_scan_runs; surface it.
      console.error(
        "[instrumentation:drive-sales] tick failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      inFlight = false;
    }
  };

  // 195s — the next free slot after the Drive mirror sweep at 180s, so a cold
  // boot does not fire every job at once. This one is last on purpose: it is
  // the least urgent and the most expensive per tick.
  const kickoff = setTimeout(tick, 195_000);
  if (typeof kickoff.unref === "function") kickoff.unref();

  const interval = setInterval(tick, SCAN_INTERVAL_MS);
  if (typeof interval.unref === "function") interval.unref();

  console.log(
    `[instrumentation] drive-sales-scan (${Math.round(
      SCAN_INTERVAL_MS / 60_000,
    )}m) started in-process`,
  );
}
