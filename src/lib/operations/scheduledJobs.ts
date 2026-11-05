// ID 227 — every scheduled job the CRM has, in one list: what it does, what
// runs it on the live server, and the ones deliberately left off.
//
// Why a list: vercel.json names 22 crons, and none of them fires on the PM2
// servers (docs/DEPLOY_RUNBOOK.md). Each is either run by an in-process ticker
// (src/instrumentation-node.ts, started under runAsJob(<job>)), covered by
// another job, or switched off with a reason. Ops Console > Jobs reads this
// list plus scheduled_job_state (E-372) for each job's last run.
//
// A contract test (src/lib/operations/__tests__/scheduledJobs.test.ts) fails
// when vercel.json or instrumentation.ts gains a job that is not listed here,
// so a new cron can no longer silently never run.
//
// Client-safe: no imports.

export type JobRunner =
  /** In-process ticker. `job` is its scheduled_job_state name. */
  | {
      kind: "ticker";
      job: string;
      everyMs: number;
      /** Once-a-day jobs: the digest_runs kind that records the day's real run. */
      dailyKind?: string;
      /** Plain-words time of the daily run. */
      dailyAt?: string;
      /** Env switch that turns it off (… = "0"). */
      offSwitch?: string;
    }
  /** Done inside another job. */
  | { kind: "covered"; by: string; note: string }
  /** Deliberately not run. Needs a decision before switching on. */
  | { kind: "off"; reason: string; decision: string };

export type ScheduledJob = {
  id: string;
  title: string;
  /** What it does, in plain words. */
  what: string;
  /** vercel.json cron paths this entry stands for (exact strings). */
  cronPaths: string[];
  runner: JobRunner;
};

const MIN = 60_000;
const HOUR = 60 * MIN;

export const SCHEDULED_JOBS: ScheduledJob[] = [
  // ── AI dialer & calls ────────────────────────────────────────────────────
  {
    id: "dialer-poll",
    title: "AI dialer: call status poll",
    what: "Checks the status of AI campaign calls in progress.",
    cronPaths: ["/api/cron/dialer-poll"],
    runner: { kind: "ticker", job: "dialer:poll", everyMs: 30_000, offSwitch: "ENABLE_DIALER_POLL" },
  },
  {
    id: "dialer-watchdog",
    title: "AI dialer: stuck-call watchdog",
    what: "Frees campaign leads stuck in 'calling' and moves campaigns on.",
    cronPaths: ["/api/cron/dialer-watchdog"],
    runner: { kind: "ticker", job: "dialer:watchdog", everyMs: 2 * MIN, offSwitch: "ENABLE_DIALER_POLL" },
  },
  {
    id: "campaign-window",
    title: "AI dialer: calling-window resume",
    what: "Starts or pauses scheduled campaigns at their calling window.",
    cronPaths: ["/api/cron/campaign-resume"],
    runner: { kind: "ticker", job: "dialer:window", everyMs: MIN, offSwitch: "ENABLE_CAMPAIGN_RESUME" },
  },
  {
    id: "callback-loop",
    title: "AI callbacks: reminders and overdue alerts",
    what: "Reminds the owner 15 min before an agreed callback; alerts the Sales Head and manager 30 min after a missed one; expires old ones.",
    cronPaths: [],
    runner: { kind: "ticker", job: "callback-loop", everyMs: 5 * MIN },
  },
  {
    id: "call-cost-backfill",
    title: "AI call costs",
    what: "Fetches each finished AI call's cost from Bolna / ElevenLabs when the call itself did not record it.",
    cronPaths: ["/api/cron/backfill-call-costs"],
    runner: { kind: "ticker", job: "call-cost-backfill", everyMs: 15 * MIN, offSwitch: "ENABLE_CALL_COST_BACKFILL" },
  },
  {
    id: "recording-transcription",
    title: "Call recording transcription",
    what: "Transcribes uploaded call recordings.",
    cronPaths: [],
    runner: { kind: "ticker", job: "recording-transcription", everyMs: 15_000, offSwitch: "ENABLE_RECORDING_TRANSCRIPTION" },
  },
  {
    id: "bolna-call-scheduler",
    title: "Bolna follow-up call scheduler",
    what: "Would dial leads whose AI follow-up time (next_call_at) is due.",
    cronPaths: ["/api/bolna/call-scheduler"],
    runner: {
      kind: "off",
      reason: "Places paid AI calls. Today every such lead is already handed to Inside Sales (AI follow-up loop retired), so it would dial almost nobody.",
      decision: "Kartik's OK before switching on",
    },
  },
  {
    id: "elevenlabs-call-scheduler",
    title: "ElevenLabs follow-up call scheduler",
    what: "Same as the Bolna scheduler, for ElevenLabs leads.",
    cronPaths: ["/api/elevenlabs/call-scheduler"],
    runner: {
      kind: "off",
      reason: "Places paid AI calls; dials almost nobody today (AI follow-up loop retired).",
      decision: "Kartik's OK before switching on",
    },
  },

  // ── Leads, sales, accounts ───────────────────────────────────────────────
  {
    id: "zoho-sync",
    title: "Zoho invoice sync",
    what: "Copies new and changed Zoho invoices into the CRM.",
    cronPaths: ["/api/cron/zoho-sync"],
    runner: { kind: "ticker", job: "zoho-sync", everyMs: HOUR },
  },
  {
    id: "dispatch-to-sold",
    title: "Dispatched → delivered",
    what: "A sale dispatched more than a day ago becomes delivered, as if the dealer pressed Mark delivered.",
    cronPaths: ["/api/cron/dispatch-to-sold"],
    runner: {
      kind: "ticker",
      job: "dispatch-to-sold",
      everyMs: 5 * MIN,
      dailyKind: "dispatch_to_sold",
      dailyAt: "09:30 IST",
      offSwitch: "ENABLE_DISPATCH_TO_SOLD",
    },
  },
  {
    id: "lead-clocks",
    title: "Lead clocks",
    what: "Rebuilds lead and owner clocks and records 'Limit passed' misses.",
    cronPaths: [],
    runner: { kind: "ticker", job: "lead-clocks", everyMs: HOUR },
  },
  {
    id: "kyc-auto-approval",
    title: "KYC auto-approval",
    what: "Accepts KYC checks left unreviewed past their time limit.",
    cronPaths: ["/api/cron/kyc-auto-approval"],
    runner: { kind: "ticker", job: "kyc-auto-approval", everyMs: 10_000 },
  },
  {
    id: "digilocker-expiry",
    title: "DigiLocker expired requests",
    what: "Writes 'DigiLocker request expired' in the KYC history when a link runs out, for both borrowers.",
    cronPaths: [],
    runner: { kind: "ticker", job: "digilocker-expiry", everyMs: 15 * MIN, offSwitch: "ENABLE_DIGILOCKER_EXPIRY_SWEEP" },
  },
  {
    id: "dealer-agreement-refresh",
    title: "Dealer agreement status",
    what: "Refreshes dealer agreement e-sign status.",
    cronPaths: ["/api/cron/dealer-agreement-refresh"],
    runner: { kind: "ticker", job: "dealer-agreement-refresh", everyMs: 15 * MIN },
  },
  {
    id: "agreement-expiry-reminder",
    title: "Dealer agreement expiry reminders",
    what: "Reminds before a dealer agreement expires.",
    cronPaths: ["/api/cron/dealer-agreement-expiry-reminder"],
    runner: { kind: "ticker", job: "agreement-expiry-reminder", everyMs: HOUR },
  },
  {
    id: "dealer-reorder-reminders",
    title: "Dealer reorder reminders",
    what: "Orange nudge, monthly Dormant win-back, the CEO's 'turned Dormant' alert.",
    cronPaths: [],
    runner: { kind: "ticker", job: "dealer-reorder-reminders", everyMs: HOUR },
  },
  {
    id: "dealer-payment-reminder",
    title: "Loan payment received reminder",
    what: "One 48-hour 'confirm loan payment received' reminder.",
    cronPaths: [],
    runner: { kind: "ticker", job: "dealer-payment-reminder", everyMs: 15 * MIN },
  },
  {
    id: "invoice-freshness",
    title: "No new invoice alert",
    what: "No new invoice for 3 working days → one Admin bell a day.",
    cronPaths: [],
    runner: { kind: "ticker", job: "invoice-freshness", everyMs: HOUR },
  },
  {
    id: "stock-upload-sweep",
    title: "Stock to upload",
    what: "Re-checks and escalates 'Stock to upload' tasks.",
    cronPaths: [],
    runner: { kind: "ticker", job: "stock-upload-sweep", everyMs: HOUR },
  },
  {
    id: "scraper-queue",
    title: "Scraper queue",
    what: "Runs queued lead-scrape jobs.",
    cronPaths: [],
    runner: { kind: "ticker", job: "scraper-queue", everyMs: 30_000, offSwitch: "ENABLE_SCRAPER_QUEUE" },
  },
  {
    id: "ecofy-reminder",
    title: "Ecofy reminders",
    what: "Ecofy follow-up and meeting reminders.",
    cronPaths: [],
    runner: { kind: "ticker", job: "ecofy-reminder", everyMs: 5 * MIN },
  },
  {
    id: "wa-assistant-sweep",
    title: "WhatsApp assistant sweep",
    what: "Expires 10-minute previews; recovers actions a dead process left running.",
    cronPaths: [],
    runner: { kind: "ticker", job: "wa-assistant-sweep", everyMs: MIN, offSwitch: "ENABLE_WA_ASSIST_SWEEP" },
  },

  // ── Emails and reports ───────────────────────────────────────────────────
  {
    id: "digest",
    title: "Daily emails (digests)",
    what: "Sends the scheduled emails: My day, Sales Daily, Missed callbacks and the others, each at its time.",
    cronPaths: [],
    runner: { kind: "ticker", job: "digest", everyMs: 5 * MIN },
  },
  {
    id: "monitor-morning",
    title: "Fleet Monitor morning card",
    what: "The 08:00 IST Fleet Monitor card to Telegram.",
    cronPaths: [],
    runner: {
      kind: "ticker",
      job: "monitor-morning",
      everyMs: 5 * MIN,
      dailyKind: "monitor_morning",
      dailyAt: "08:00 IST",
      offSwitch: "ENABLE_MONITOR_MORNING",
    },
  },
  {
    id: "green-news",
    title: "Green energy news",
    what: "Refreshes the news card on the CEO dashboard.",
    cronPaths: [],
    runner: { kind: "ticker", job: "green-news", everyMs: 30 * MIN, offSwitch: "ENABLE_GREEN_NEWS" },
  },
  {
    id: "ops-monitor",
    title: "Ops Console collectors",
    what: "Runs the Ops Console's own collectors (see Collectors below).",
    cronPaths: [],
    runner: { kind: "ticker", job: "ops-monitor", everyMs: MIN, offSwitch: "ENABLE_OPS_MONITOR" },
  },

  // ── Google Drive ─────────────────────────────────────────────────────────
  {
    id: "drive-mirror",
    title: "Drive mirror",
    what: "Copies uploaded files to Google Drive; a full back-fill pass every 6 hours.",
    cronPaths: ["/api/cron/gdrive-mirror", "/api/cron/gdrive-mirror?backfill=1"],
    runner: { kind: "ticker", job: "drive-mirror", everyMs: MIN, offSwitch: "ENABLE_GDRIVE_MIRROR_TICKER" },
  },
  {
    id: "drive-sales",
    title: "Drive sales invoices",
    what: "Reads new Vyapar sales invoice PDFs from Google Drive.",
    cronPaths: [],
    runner: { kind: "ticker", job: "drive-sales", everyMs: 6 * HOUR, offSwitch: "ENABLE_DRIVE_SALES_SCAN" },
  },
  {
    id: "drive-sales-daily",
    title: "Drive sales invoices: 08:30 scan",
    what: "One extra scan at 08:30 IST so the morning Sales email reads fresh revenue.",
    cronPaths: [],
    runner: {
      kind: "ticker",
      job: "drive-sales:daily",
      everyMs: 5 * MIN,
      dailyKind: "drive_sales_0830",
      dailyAt: "08:30 IST",
      offSwitch: "ENABLE_DRIVE_SALES_DAILY",
    },
  },
  {
    id: "drive-expense",
    title: "Drive expense bills",
    what: "Reads new expense bills from Google Drive.",
    cronPaths: [],
    runner: { kind: "ticker", job: "drive-expense", everyMs: 6 * HOUR, offSwitch: "ENABLE_DRIVE_EXPENSE_SCAN" },
  },

  // ── Buyback ──────────────────────────────────────────────────────────────
  {
    id: "buyback-dispatch",
    title: "Buyback: dispatch",
    what: "Moves buyback requests through dispatch.",
    cronPaths: [],
    runner: { kind: "ticker", job: "buyback-dispatch", everyMs: 30_000 },
  },
  {
    id: "buyback-dedup",
    title: "Buyback: duplicate sweep",
    what: "Finds duplicate buyback requests.",
    cronPaths: [],
    runner: { kind: "ticker", job: "buyback-dedup:dedup", everyMs: 6 * HOUR },
  },
  {
    id: "buyback-agreements",
    title: "Buyback: agreement status",
    what: "Refreshes buyback agreement status.",
    cronPaths: [],
    runner: { kind: "ticker", job: "buyback-dedup:agreements", everyMs: 2 * MIN },
  },
  {
    id: "buyback-price-nudge",
    title: "Buyback: price review nudge",
    what: "Daily nudge to review buyback prices.",
    cronPaths: [],
    runner: { kind: "ticker", job: "buyback-dedup:nudge", everyMs: 24 * HOUR },
  },
  {
    id: "buyback-gateway",
    title: "Buyback: payment gateway",
    what: "Checks online buyback payments.",
    cronPaths: [],
    runner: { kind: "ticker", job: "buyback-gateway", everyMs: MIN },
  },
  {
    id: "oem-price-sweep",
    title: "OEM price sweep",
    what: "Refreshes OEM prices.",
    cronPaths: [],
    runner: { kind: "ticker", job: "oem-price-sweep", everyMs: 6 * HOUR, offSwitch: "ENABLE_OEM_PRICE_SWEEP" },
  },
  {
    id: "auction",
    title: "Auctions",
    what: "Opens and closes auctions on time.",
    cronPaths: [],
    runner: { kind: "ticker", job: "auction", everyMs: 15_000 },
  },

  // ── Batteries ────────────────────────────────────────────────────────────
  {
    id: "iot-offline-scan",
    title: "Offline battery alerts",
    what: "Raises 'Battery Offline' (>24 h) and 'Offline Extended' (>48 h) alerts. Skips while no device has reported for 7 days.",
    cronPaths: ["/api/cron/iot/scan-offline-batteries"],
    runner: { kind: "ticker", job: "iot-offline-scan", everyMs: 15 * MIN, offSwitch: "ENABLE_IOT_OFFLINE_SCAN" },
  },

  // ── NBFC / loans ─────────────────────────────────────────────────────────
  {
    id: "nbfc-nightly",
    title: "NBFC nightly: risk scores, anomaly flags, COR expiry",
    what: "Borrower risk scores (CDS), then each loan's concern index (PCI), lender anomaly flags, and COR expiry alerts. Sends nothing.",
    cronPaths: [
      "/api/cron/nbfc/compute-cds",
      "/api/cron/nbfc/compute-pci",
      "/api/cron/nbfc/evaluate-anomaly-flags",
      "/api/cron/nbfc-cor-expiry",
    ],
    runner: {
      kind: "ticker",
      job: "nbfc-nightly",
      everyMs: 5 * MIN,
      dailyKind: "nbfc_nightly",
      dailyAt: "05:30 IST",
      offSwitch: "ENABLE_NBFC_NIGHTLY",
    },
  },
  {
    id: "nbfc-request-sla",
    title: "NBFC request time limits",
    what: "Flags NBFC requests past their time limit.",
    cronPaths: ["/api/cron/nbfc-request-sla"],
    runner: { kind: "ticker", job: "nbfc-request-sla", everyMs: MIN },
  },
  {
    id: "emi-messages",
    title: "EMI ageing + EMI messages",
    what: "Ages EMIs (scheduled → overdue, days past due), then sends the scheduled EMI messages to customers.",
    cronPaths: [],
    runner: { kind: "ticker", job: "emi-messages", everyMs: HOUR },
  },
  {
    id: "emi-aging",
    title: "EMI ageing",
    what: "Moves EMIs past their due date to overdue and counts days past due.",
    cronPaths: ["/api/cron/nbfc/run-emi-aging"],
    runner: { kind: "covered", by: "emi-messages", note: "Runs hourly as the first step of EMI ageing + EMI messages." },
  },
  {
    id: "emi-autodebit",
    title: "EMI auto-debit",
    what: "Collects due EMIs through the customer's mandate.",
    cronPaths: ["/api/cron/nbfc/run-emi-autodebit"],
    runner: {
      kind: "off",
      reason: "In its default mode (simulate) it marks an EMI paid without collecting any money; in live mode it starts real debits.",
      decision: "Kartik's OK, with EMI_AUTODEBIT_MODE decided",
    },
  },
  {
    id: "nbfc-origination-maintenance",
    title: "NBFC origination upkeep",
    what: "Manual hand-off emails, e-NACH stale-risk and field-check time-limit flags, and wallet auto-NACH top-ups.",
    cronPaths: ["/api/cron/nbfc-origination-maintenance"],
    runner: {
      kind: "off",
      reason: "Its wallet step starts real auto-NACH debits on lender wallets.",
      decision: "Kartik's OK before switching on",
    },
  },
];

/** Every vercel.json cron path the list accounts for. */
export function listedCronPaths(jobs: ScheduledJob[] = SCHEDULED_JOBS): Set<string> {
  return new Set(jobs.flatMap((j) => j.cronPaths));
}

/** The scheduled_job_state names of every ticker in the list. */
export function tickerJobNames(jobs: ScheduledJob[] = SCHEDULED_JOBS): string[] {
  return jobs.flatMap((j) => (j.runner.kind === "ticker" ? [j.runner.job] : []));
}

export type JobHealth = "ok" | "late" | "failed" | "never" | "off" | "covered" | "pending";

/**
 * Pure: how a ticker looks from its last tick and (for once-a-day jobs) its
 * last daily run. Late = no tick for more than twice its interval (plus 5 min
 * of boot slack); a daily job is also late once its time has passed today
 * with no run today.
 */
export function jobHealth(
  runner: JobRunner,
  last: { finishedAt: Date | null; status: string | null } | null,
  now: Date,
  daily?: { istDate: string | null; status: string | null; dueToday: boolean; todayIst: string },
): JobHealth {
  if (runner.kind === "off") return "off";
  if (runner.kind === "covered") return "covered";
  if (!last || !last.finishedAt) return "never";
  if (last.status === "failed") return "failed";
  const ageMs = now.getTime() - last.finishedAt.getTime();
  if (ageMs > 2 * runner.everyMs + 5 * MIN) return "late";
  if (daily) {
    if (daily.istDate === daily.todayIst && daily.status === "failed") return "failed";
    if (daily.dueToday && daily.istDate !== daily.todayIst) return "late";
  }
  return "ok";
}

/** "every 30 s" / "every 15 min" / "hourly" / "daily at 09:30 IST". */
export function scheduleText(runner: JobRunner): string {
  if (runner.kind === "off") return "off";
  if (runner.kind === "covered") return `inside ${runner.by}`;
  if (runner.dailyAt) return `daily at ${runner.dailyAt}`;
  const ms = runner.everyMs;
  if (ms < MIN) return `every ${Math.round(ms / 1000)} s`;
  if (ms === HOUR) return "hourly";
  if (ms < HOUR) return `every ${Math.round(ms / MIN)} min`;
  if (ms === 24 * HOUR) return "daily";
  return `every ${Math.round(ms / HOUR)} h`;
}
