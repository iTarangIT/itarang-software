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
