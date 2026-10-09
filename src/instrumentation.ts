// Next.js instrumentation — runs once when the server boots (next dev,
// next start, or `node server.js`). It kicks off the in-process dialer
// tickers (poll + watchdog) so the AI dialer self-heals without needing
// a separate worker terminal. See instrumentation-node.ts for the detail.
//
// The `if (process.env.NEXT_RUNTIME === "nodejs")` wrapper is
// load-bearing — keep it a wrapping block, NEVER an early return.
// webpack replaces process.env.NEXT_RUNTIME with a string literal at
// build time, so for the Edge compilation this becomes `if (false) {…}`
// and webpack prunes the dynamic import() — plus its entire
// Drizzle/postgres-js + googleapis graph — from the edge bundle.
//
// After an early `return`, webpack does NOT prune (it only dead-code-
// eliminates statically-false `if` branches, not statements following a
// `return`). It would still compile instrumentation-node -> googleapis
// -> node:http for the Edge runtime, where Node built-ins don't exist,
// and the build fails with "Module not found: Can't resolve 'http'".
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const {
      startDialerTickers,
      startZohoSyncTicker,
      startBuybackDispatchTicker,
      startBuybackDedupTicker,
      startBuybackGatewayTicker,
      startDriveExpenseTicker,
      startOemPriceSweepTicker,
      startAuctionTicker,
      startScraperQueueTicker,
      startKycAutoApprovalTicker,
      startNbfcRequestSlaTicker,
      startEcofyReminderTicker,
      startRecordingTranscriptionTicker,
      startDriveMirrorTicker,
      startDriveSalesTicker,
      startOpsMonitorTicker,
      startDigestTicker,
      startDealerPaymentReminderTicker,
      startMonitorMorningTicker,
      startGreenNewsTicker,
      startWaAssistantSweepTicker,
      startDealerAgreementRefreshTicker,
      startAgreementExpiryReminderTicker,
      startDealerReorderReminderTicker,
    } = await import("./instrumentation-node");
    // ID 125 — every ticker runs as a named job. Its timers inherit the job
    // context, so the email / WhatsApp / Telegram senders drop what a job tries
    // to send from a site that is not the live CRM (src/lib/runtime/liveSite.ts).
    const { runAsJob } = await import("./lib/runtime/liveSite");
    await runAsJob("dialer", startDialerTickers);
    await runAsJob("zoho-sync", startZohoSyncTicker);
    await runAsJob("buyback-dispatch", startBuybackDispatchTicker);
    await runAsJob("buyback-dedup", startBuybackDedupTicker);
    await runAsJob("buyback-gateway", startBuybackGatewayTicker);
    await runAsJob("drive-expense", startDriveExpenseTicker);
    await runAsJob("oem-price-sweep", startOemPriceSweepTicker);
    await runAsJob("auction", startAuctionTicker);
    await runAsJob("scraper-queue", startScraperQueueTicker);
    await runAsJob("kyc-auto-approval", startKycAutoApprovalTicker);
    await runAsJob("nbfc-request-sla", startNbfcRequestSlaTicker);
    // E-307 — Ecofy follow-up / meeting reminders (kickoff 170s out).
    await runAsJob("ecofy-reminder", startEcofyReminderTicker);
    // ID 53 — dealer agreement status refreshes itself (kickoff 210s out).
    await runAsJob("dealer-agreement-refresh", startDealerAgreementRefreshTicker);
    // ID 53 — agreement expiry reminders, hourly (kickoff 215s out); the
    // Vercel cron for it never fired on the pm2 boxes.
    await runAsJob("agreement-expiry-reminder", startAgreementExpiryReminderTicker);
    // ID 5 — dealer reorder reminders, hourly (kickoff 220s out): Orange nudge,
    // monthly Dormant win-back, the CEO's "turned Dormant" alert.
    await runAsJob("dealer-reorder-reminders", startDealerReorderReminderTicker);
    await runAsJob("recording-transcription", startRecordingTranscriptionTicker);
    await runAsJob("drive-mirror", startDriveMirrorTicker);
    // E-280 — Drive sales-invoice scan. Kickoff staggered 195s out, the last
    // free slot, because it is the least urgent and the most expensive per tick.
    await runAsJob("drive-sales", startDriveSalesTicker);
    // Ops Console collector runner (E-210). Last, and its own kickoff is
    // staggered 75s out, so a cold boot finishes wiring the app before the
    // monitoring starts querying the database it monitors.
    await runAsJob("ops-monitor", startOpsMonitorTicker);
    // E-287/E-288 — the twice-daily digest emails. Truly last: the kickoff is
    // 195s out, behind every collector, because a summary mail is the
    // lowest-priority thing a freshly-booted process could be doing.
    await runAsJob("digest", startDigestTicker);
    // E-298 — one-shot 48h "confirm loan payment received" reminder.
    await runAsJob("dealer-payment-reminder", startDealerPaymentReminderTicker);
    // The 08:00 IST Fleet Monitor card to Telegram. Kickoff 225s out, behind
    // the digests — it launches Chromium, the most expensive thing any ticker
    // here does, and its send window is hours wide.
    await runAsJob("monitor-morning", startMonitorMorningTicker);
    // E-306 — Green Energy News refresh for the CEO dashboard. Kickoff 240s
    // out, last of all: a news fetch is the least urgent work on boot.
    await runAsJob("green-news", startGreenNewsTicker);
    // WhatsApp Sales Assistant — expire 10-minute previews, recover actions a
    // dead process left `executing`; reports a WA_ASSIST_* misconfiguration once.
    await runAsJob("wa-assistant-sweep", startWaAssistantSweepTicker);
  }
}
