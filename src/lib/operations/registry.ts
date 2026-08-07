/**
 * The metric registry — one entry per monitored number.
 *
 * THIS IS THE FILE YOU EDIT TO ADD A METRIC. Adding a monitor is:
 *   1. one new collector file under collectors/,
 *   2. one or more entries here,
 *   3. one line in collectors/index.ts.
 * Nothing else in the system changes. Pages, thresholds, alerting and the
 * one-slide board all read from this list.
 *
 * `key` is the contract between a collector and everything downstream — it is
 * written into ops_metric_samples and ops_daily_snapshots, so RENAMING A KEY
 * ORPHANS ITS HISTORY. Treat keys as append-only.
 */

export type OpsModule =
  | "infra"
  | "database"
  | "logs"
  | "spend"
  | "business"
  | "team"
  | "system"
  // CRM usage (E-214). Distinct from "team": that one is licence and capacity
  // from Supabase sign-in recency; this one is observed usage of the CRM.
  | "usage";

export type MetricUnit =
  | "count"
  | "percent"
  | "bytes"
  | "ms"
  | "inr_paise"
  | "credits"
  | "bool"
  | "days";

export interface MetricDef {
  /** Stable, dot-namespaced, e.g. "host.disk_used_pct". Never rename. */
  key: string;
  label: string;
  module: OpsModule;
  unit: MetricUnit;
  /**
   * Which way is bad. Drives the comparator seeded into ops_alert_rules:
   * lower_is_better → 'gt' (breach above the threshold);
   * higher_is_better → 'lt' (breach below it).
   * "neutral" metrics are tracked but never alerted on.
   */
  direction: "higher_is_better" | "lower_is_better" | "neutral";
  /** Seed values for ops_alert_rules. Omit both to track without alerting. */
  warn?: number;
  crit?: number;
  /** Show on the one-slide board. Keep this list short — it must fit a screen. */
  onSlide?: boolean;
  /** Tooltip: what this means, and what to do when it goes red. */
  help?: string;
}

export const METRICS: MetricDef[] = [
  // ---------------------------------------------------------------- system --
  {
    key: "app.uptime_s",
    label: "App uptime",
    module: "system",
    unit: "count",
    direction: "neutral",
    help: "Seconds since this Next.js process booted. A number that keeps resetting means pm2 is restarting the app — check the restart count on Infrastructure.",
  },
  {
    key: "app.health_ok",
    label: "App health",
    module: "system",
    unit: "bool",
    direction: "higher_is_better",
    warn: 1,
    crit: 1,
    onSlide: true,
    help: "Whether /api/health reports the CRM database reachable. This is the same check the deploy gate polls, so 0 here means a deploy would roll back.",
  },
  {
    key: "app.health_latency_ms",
    label: "Health check latency",
    module: "system",
    unit: "ms",
    direction: "lower_is_better",
    warn: 800,
    crit: 1400,
    help: "Round-trip of the /api/health dependency probe. Rising latency here usually precedes connection exhaustion.",
  },
  {
    key: "app.dep_ok",
    label: "Dependency up",
    module: "system",
    unit: "bool",
    direction: "higher_is_better",
    warn: 1,
    crit: 1,
    help: "Per-dependency up/down from /api/health — one sample per dependency, distinguished by source (crm_db, iot_bridge, sandbox).",
  },
  {
    key: "app.dep_latency_ms",
    label: "Dependency latency",
    module: "system",
    unit: "ms",
    direction: "lower_is_better",
    warn: 1000,
    crit: 1500,
    help: "Per-dependency probe time. The probe itself times out at 1.5s, so a value at the ceiling means the dependency did not answer.",
  },
  {
    key: "app.redis_circuit_open",
    label: "Upstash quota circuit open",
    module: "system",
    unit: "bool",
    direction: "lower_is_better",
    warn: 1,
    crit: 1,
    help: "1 means the Upstash quota circuit breaker has tripped and queue work is being shed. Check the Upstash plan usage.",
  },
  {
    key: "job.last_run_age_min",
    label: "Job last run age",
    module: "system",
    unit: "count",
    direction: "lower_is_better",
    warn: 180,
    crit: 1440,
    onSlide: true,
    help: "Minutes since each background job last completed, one sample per job. This is the metric that would have caught the Zoho sync ticker being dead on prod.",
  },
  {
    key: "job.last_run_failed",
    label: "Job last run failed",
    module: "system",
    unit: "bool",
    direction: "lower_is_better",
    warn: 1,
    crit: 1,
    help: "1 when a job's most recent run ended in failure. Pair with job.last_run_age_min — a job can be failing fast and still look recent.",
  },

  // ----------------------------------------------------------------- infra --
  {
    key: "host.cpu_pct",
    label: "CPU used",
    module: "infra",
    unit: "percent",
    direction: "lower_is_better",
    warn: 80,
    crit: 92,
    onSlide: true,
    help: "Derived from load average over CPU count. Sustained highs mean the box needs more cores, not a restart.",
  },
  {
    key: "host.load1",
    label: "Load average (1m)",
    module: "infra",
    unit: "count",
    direction: "lower_is_better",
    help: "Raw 1-minute load. Read it against CPU count — load 4 on a 4-core box is saturated, on a 16-core box it is idle.",
  },
  {
    key: "host.mem_used_pct",
    label: "Memory used",
    module: "infra",
    unit: "percent",
    direction: "lower_is_better",
    warn: 85,
    crit: 94,
    onSlide: true,
    help: "Once this passes the pm2 max_memory_restart ceiling the web process is killed and restarted mid-request.",
  },
  {
    key: "host.swap_used_pct",
    label: "Swap used",
    module: "infra",
    unit: "percent",
    direction: "lower_is_better",
    warn: 20,
    crit: 60,
    help: "Any sustained swap on these boxes means memory pressure. Latency degrades long before it hits 100.",
  },
  {
    key: "host.disk_used_pct",
    label: "Disk used",
    module: "infra",
    unit: "percent",
    direction: "lower_is_better",
    warn: 80,
    crit: 90,
    onSlide: true,
    help: "A full disk takes the app down hard and silently. This has happened here before, via runaway logging — see src/lib/log.ts.",
  },
  {
    key: "host.disk_free_gb",
    label: "Disk free",
    module: "infra",
    unit: "count",
    direction: "higher_is_better",
    warn: 8,
    crit: 3,
    help: "Absolute headroom in GB. Watch this alongside the percentage — 10% of a small volume is not much runway.",
  },
  {
    key: "host.inode_used_pct",
    label: "Inodes used",
    module: "infra",
    unit: "percent",
    direction: "lower_is_better",
    warn: 80,
    crit: 90,
    help: "Inode exhaustion looks exactly like a full disk to the app while df shows free space. Usually millions of small files.",
  },
  {
    key: "host.uptime_s",
    label: "Host uptime",
    module: "infra",
    unit: "count",
    direction: "neutral",
    help: "Seconds since the box booted. An unexpected reset means the VPS rebooted — check that pm2 resurrected everything.",
  },
  {
    key: "host.cert_days_left",
    label: "SSL days left",
    module: "infra",
    unit: "days",
    direction: "higher_is_better",
    warn: 21,
    crit: 7,
    onSlide: true,
    help: "Days until the served certificate expires. An expired cert takes down the whole site, including this dashboard.",
  },
  {
    key: "host.agent_age_min",
    label: "Agent last seen",
    module: "infra",
    unit: "count",
    direction: "lower_is_better",
    warn: 15,
    crit: 60,
    onSlide: true,
    help: "Minutes since this host last POSTed. The agent runs every 5 minutes, so a rising number means the agent — or the box — is gone, and every other host metric is stale.",
  },
  {
    key: "process.online",
    label: "pm2 process online",
    module: "infra",
    unit: "bool",
    direction: "higher_is_better",
    warn: 1,
    crit: 1,
    help: "1 when pm2 reports the process online. One sample per process, distinguished by source.",
  },
  {
    key: "process.restarts",
    label: "pm2 restart count",
    module: "infra",
    unit: "count",
    direction: "lower_is_better",
    warn: 25,
    crit: 100,
    help: "Cumulative pm2 restarts. A number climbing between collections is a crash loop — pm2 counts a max_memory_restart kill as a restart too.",
  },
  {
    key: "process.mem_mb",
    label: "pm2 process memory",
    module: "infra",
    unit: "count",
    direction: "lower_is_better",
    warn: 750,
    crit: 870,
    help: "Resident memory in MB. Prod's max_memory_restart is 900M, so the crit threshold sits just under the level where pm2 kills the process.",
  },

  // -------------------------------------------------------------- database --
  {
    key: "db.connections_used",
    label: "Connections in use",
    module: "database",
    unit: "count",
    direction: "lower_is_better",
    warn: 55,
    crit: 70,
    onSlide: true,
    help: "RDS has ~79 max_connections and NO pooler; a deploy burst trips 53300 and fails /api/health, which rolls the deploy back. This is the highest-value number on the board.",
  },
  {
    key: "db.connections_pct",
    label: "Connection headroom used",
    module: "database",
    unit: "percent",
    direction: "lower_is_better",
    warn: 70,
    crit: 88,
    onSlide: true,
    help: "Connections in use as a share of max_connections. Percentage rather than count, so it stays meaningful if the instance is ever resized.",
  },
  {
    key: "db.max_connections",
    label: "max_connections",
    module: "database",
    unit: "count",
    direction: "neutral",
    help: "The server's configured ceiling. Recorded so a silent instance resize is visible in the history rather than confusing the headroom chart.",
  },
  {
    key: "db.longest_query_s",
    label: "Longest running query",
    module: "database",
    unit: "count",
    direction: "lower_is_better",
    warn: 60,
    crit: 300,
    help: "Seconds. A query running for minutes is usually a missing index or a runaway report, and it holds a connection the whole time.",
  },
  {
    key: "db.longest_idle_tx_s",
    label: "Longest idle in transaction",
    module: "database",
    unit: "count",
    direction: "lower_is_better",
    warn: 120,
    crit: 600,
    help: "Seconds. Idle-in-transaction blocks autovacuum and holds locks — far more dangerous than a slow query of the same age.",
  },
  {
    key: "db.cache_hit_pct",
    label: "Cache hit ratio",
    module: "database",
    unit: "percent",
    direction: "higher_is_better",
    warn: 97,
    crit: 90,
    help: "Share of block reads served from shared buffers. A sustained drop means the working set no longer fits in memory.",
  },
  {
    key: "db.deadlocks",
    label: "Deadlocks",
    module: "database",
    unit: "count",
    direction: "lower_is_better",
    warn: 1,
    crit: 10,
    help: "Cumulative deadlocks since stats were last reset. Any movement is worth a look.",
  },
  {
    key: "db.rollback_pct",
    label: "Rollback ratio",
    module: "database",
    unit: "percent",
    direction: "lower_is_better",
    warn: 5,
    crit: 15,
    help: "Rollbacks as a share of transactions. A jump usually means a route is erroring after it opens a transaction.",
  },
  {
    key: "db.size_bytes",
    label: "Database size",
    module: "database",
    unit: "bytes",
    direction: "neutral",
    help: "Total on-disk size. Watched for growth rate rather than an absolute threshold.",
  },
  {
    key: "db.dead_tuples",
    label: "Dead tuples",
    module: "database",
    unit: "count",
    direction: "lower_is_better",
    warn: 500_000,
    crit: 5_000_000,
    help: "Rows awaiting vacuum across all tables. A large number that never falls means autovacuum is not keeping up.",
  },
  {
    key: "db.table_bytes",
    label: "Table size",
    module: "database",
    unit: "bytes",
    direction: "neutral",
    help: "Per-table total relation size, one sample per table. Drives the top-20 tables list.",
  },
  {
    key: "db.table_rows",
    label: "Table row estimate",
    module: "database",
    unit: "count",
    direction: "neutral",
    help: "Per-table live-tuple estimate from pg_stat_user_tables. An estimate, not a count(*).",
  },
  {
    key: "db.migration_drift",
    label: "Schema drift",
    module: "database",
    unit: "count",
    direction: "lower_is_better",
    warn: 1,
    crit: 5,
    onSlide: true,
    help: "Tables declared in schema.ts but absent from this database — i.e. unapplied migrations. Surfaces at runtime as 'relation does not exist', because Drizzle names every column in its INSERTs.",
  },

  // ------------------------------------------------------------------ logs --
  {
    key: "logs.error_count_1h",
    label: "Errors (1h)",
    module: "logs",
    unit: "count",
    direction: "lower_is_better",
    warn: 50,
    crit: 300,
    onSlide: true,
    help: "Error-level lines forwarded by the agents in the last hour, across all hosts.",
  },
  {
    key: "logs.distinct_errors_1h",
    label: "Distinct errors (1h)",
    module: "logs",
    unit: "count",
    direction: "lower_is_better",
    warn: 8,
    crit: 20,
    help: "Unique fingerprints in the last hour. One error repeated 10,000 times is one problem; ten distinct new ones is ten.",
  },

  // ----------------------------------------------------------------- spend --
  {
    key: "spend.ai_calls_cost_30d",
    label: "AI call spend (30d)",
    module: "spend",
    unit: "inr_paise",
    direction: "neutral",
    onSlide: true,
    help: "Metered cost of AI calls over the trailing 30 days, from ai_call_logs. Already INR paise for every provider — never apply an FX rate to it.",
  },
  {
    key: "spend.ai_calls_count_30d",
    label: "AI calls (30d)",
    module: "spend",
    unit: "count",
    direction: "neutral",
    help: "Call volume behind the spend figure, so a cost jump can be read as more calls or dearer calls.",
  },
  {
    key: "spend.provider_cost_30d",
    label: "Provider spend (30d)",
    module: "spend",
    unit: "inr_paise",
    direction: "neutral",
    help: "Trailing-30-day metered cost split by provider, one sample per provider.",
  },
  {
    key: "spend.billed_tech_mtd",
    label: "Billed tech spend (MTD)",
    module: "spend",
    unit: "inr_paise",
    direction: "neutral",
    onSlide: true,
    help: "Approved expense_submissions in the tech department, month to date. This is what we were actually invoiced, as opposed to what we metered.",
  },
  {
    key: "spend.billed_vendor_mtd",
    label: "Billed spend by vendor (MTD)",
    module: "spend",
    unit: "inr_paise",
    direction: "neutral",
    help: "Month-to-date approved tech spend per vendor, one sample per vendor.",
  },
  {
    key: "vendor.credits_remaining",
    label: "Vendor credits remaining",
    module: "spend",
    unit: "credits",
    direction: "higher_is_better",
    // Sized in RUNWAY, not in round numbers. ElevenLabs at peak (May 2026) burnt
    // ~115k credits/month against a ~253k quota — roughly 3.8k/day. So warn is
    // ~10 days of headroom and crit ~4 days: enough to get a plan topped up
    // through whoever holds the card, which is not a same-day operation. The
    // original 20k/5k was ~5 days and ~1.3 days, which is a fire drill rather
    // than a warning.
    warn: 40_000,
    crit: 15_000,
    onSlide: true,
    help: "Credits left on a metered vendor plan (ElevenLabs today). Nothing else polls this, so a burn-out is otherwise invisible until calls start failing. Warn is ~10 days of runway at peak burn, crit ~4 days.",
  },
  {
    key: "vendor.credits_used_pct",
    label: "Vendor quota used",
    module: "spend",
    unit: "percent",
    direction: "lower_is_better",
    warn: 80,
    crit: 93,
    help: "Share of the billing period's quota consumed. Read with the reset date — 90% on the last day of the period is fine.",
  },
  {
    key: "vendor.api_calls_30d",
    label: "Vendor API calls (30d)",
    module: "spend",
    unit: "count",
    direction: "neutral",
    help: "Billable third-party API attempts over 30 days, one sample per vendor. Counts only — we hold no rate card for these, so they cannot be costed here.",
  },

  // -------------------------------------------------------------- business --
  {
    key: "business.leads_created_mtd",
    label: "Leads created (MTD)",
    module: "business",
    unit: "count",
    direction: "higher_is_better",
    warn: 1,
    onSlide: true,
    help: "A drop to zero mid-month means a pipeline broke, not that sales stopped. That is why the warn threshold is 1.",
  },
  {
    key: "business.leads_converted_mtd",
    label: "Leads converted (MTD)",
    module: "business",
    unit: "count",
    direction: "higher_is_better",
    help: "Conversions month to date, from the same aggregation the CEO dashboard uses.",
  },
  {
    key: "business.revenue_mtd",
    label: "Revenue (MTD)",
    module: "business",
    unit: "inr_paise",
    direction: "higher_is_better",
    onSlide: true,
    help: "Month-to-date invoiced revenue. Mirrors the CEO dashboard exactly — both call the same module.",
  },
  {
    key: "business.outstanding",
    label: "Outstanding receivables",
    module: "business",
    unit: "inr_paise",
    direction: "neutral",
    help: "Unpaid invoice balances, excluding void AND draft. Omitting the draft exclusion once inflated this from ₹7.89L to ₹1.16Cr.",
  },
  {
    key: "business.dealers_onboarded_mtd",
    label: "Dealers onboarded (MTD)",
    module: "business",
    unit: "count",
    direction: "higher_is_better",
    help: "Dealer applications that completed onboarding this month.",
  },
  {
    key: "business.buyback_submitted_mtd",
    label: "Buyback submitted (MTD)",
    module: "business",
    unit: "count",
    direction: "neutral",
    help: "Buyback deals submitted this month.",
  },
  {
    key: "business.buyback_completed_mtd",
    label: "Buyback completed (MTD)",
    module: "business",
    unit: "count",
    direction: "neutral",
    help: "Buyback deals that reached a completed state this month.",
  },
  {
    key: "business.active_iot_devices",
    label: "Active IoT devices",
    module: "business",
    unit: "count",
    direction: "higher_is_better",
    warn: 1,
    help: "Batteries that reported telemetry recently. Zero means the IoT bridge stopped ingesting, not that every vehicle is parked.",
  },

  // ------------------------------------------------------------------ team --
  {
    key: "team.active_users_24h",
    label: "Active users (24h)",
    module: "team",
    unit: "count",
    direction: "neutral",
    help: "Accounts with a Supabase sign-in in the last 24 hours.",
  },
  {
    key: "team.active_users_7d",
    label: "Active users (7d)",
    module: "team",
    unit: "count",
    direction: "neutral",
    help: "Accounts with a sign-in in the last 7 days.",
  },
  {
    key: "team.active_users_30d",
    label: "Active users (30d)",
    module: "team",
    unit: "count",
    direction: "neutral",
    help: "Accounts with a sign-in in the last 30 days. The licence-capacity number.",
  },
  {
    key: "team.never_logged_in",
    label: "Never logged in",
    module: "team",
    unit: "count",
    direction: "lower_is_better",
    warn: 10,
    help: "Accounts created but never used — provisioned and forgotten, and each one is a live credential.",
  },
  {
    key: "team.inactive_30d",
    label: "Inactive over 30 days",
    module: "team",
    unit: "count",
    direction: "neutral",
    help: "Accounts with no sign-in for over 30 days. An offboarding signal, not a performance one.",
  },
  {
    key: "team.actions_24h",
    label: "Audited actions (24h)",
    module: "team",
    unit: "count",
    direction: "neutral",
    help: "Rows written to audit_logs in the last 24 hours. A proxy for system usage; a collapse to zero suggests writes are failing.",
  },

  // ----------------------------------------------------------------- usage --
  //
  // CRM usage, from our own tables (E-214) rather than from Supabase. Phase 1
  // ships logins only; the session-derived metrics (DAU/WAU/MAU, session length)
  // arrive with the heartbeat and are deliberately NOT declared yet — a MetricDef
  // with no collector behind it would seed an alert rule that fires on the
  // absence of data it was never going to receive.
  //
  // Nothing here is onSlide. The board is for things that are on fire, and a
  // healthy login count is not news; the one usage signal that IS news (the
  // pipeline dying) is covered by an alert once WAU exists.
  {
    key: "usage.logins_24h",
    label: "Logins (24h)",
    module: "usage",
    unit: "count",
    // Neutral ON PURPOSE. Alerting on "logins dropped" would page the tech team
    // because people took leave, and an ops console that cries wolf on a public
    // holiday is one nobody reads on the day it matters.
    direction: "neutral",
    help: "Credential entries in the last 24 hours — NOT visits. Supabase refresh tokens keep a session alive for days, so somebody who signed in on Monday works all week without appearing here again. Expect this to read far lower than active users.",
  },
];

const BY_KEY = new Map(METRICS.map((m) => [m.key, m]));

export function getMetric(key: string): MetricDef | undefined {
  return BY_KEY.get(key);
}

export function metricsForModule(module: OpsModule): MetricDef[] {
  return METRICS.filter((m) => m.module === module);
}

export function slideMetrics(): MetricDef[] {
  return METRICS.filter((m) => m.onSlide);
}

/**
 * The comparator a threshold on this metric should use.
 *
 * Kept here rather than in alerts.ts so that "which way is bad" is stated once,
 * next to the metric it describes.
 */
export function comparatorFor(metric: MetricDef): "gt" | "lt" {
  return metric.direction === "higher_is_better" ? "lt" : "gt";
}

export type Severity = "ok" | "warn" | "crit" | "unknown";

/**
 * THE threshold comparison. Both the page colouring (severityFor, below) and
 * the alert engine (alerts.ts, against editable ops_alert_rules rows) call this
 * one function.
 *
 * They MUST NOT have separate copies. They did briefly, and the copies drifted:
 * this one used a strict `>` while the engine used `>=` for booleans, so
 * `job.last_run_failed = 1` rendered a green tile on every page while a
 * critical alert was open against it. A monitoring console that contradicts its
 * own alerts is worse than one that stays quiet.
 *
 * BOOLEANS ARE A STATE, NOT A MAGNITUDE. `job.last_run_failed` and
 * `app.redis_circuit_open` are lower_is_better with warn = crit = 1, meaning
 * "1 is the broken state". Under a strict `>` that is `1 > 1` — false — so
 * those metrics could never breach at all.
 *
 * The asymmetry cannot be removed by making both comparators inclusive:
 * `app.dep_ok` is higher_is_better with threshold 1, so an inclusive `<=` would
 * fire `1 <= 1` on a perfectly healthy dependency.
 *
 * Magnitudes keep the strict comparison — "warn above 80%" should not fire at
 * exactly 80.
 */
export function breaches(
  comparator: "gt" | "lt",
  value: number,
  threshold: number | null | undefined,
  unit: MetricUnit | undefined,
): boolean {
  if (threshold == null || !Number.isFinite(threshold)) return false;
  if (unit === "bool") {
    return comparator === "lt" ? value < threshold : value >= threshold;
  }
  return comparator === "lt" ? value < threshold : value > threshold;
}

/**
 * Where a value sits against this metric's REGISTRY defaults.
 *
 * ops_alert_rules is the editable source of truth and is what actually fires an
 * alert; this is the colouring a page can compute without a second query, and
 * the seed those rules start from. Both go through breaches() above, so the two
 * can only disagree if someone has edited a rule — which is the intended,
 * visible kind of disagreement.
 *
 * "unknown" rather than "ok" when there is no value or no threshold: a tile
 * with nothing behind it must not render green. Green is a claim.
 */
export function severityFor(
  metric: MetricDef,
  value: number | null | undefined,
): Severity {
  if (value == null || !Number.isFinite(value)) return "unknown";
  if (metric.direction === "neutral") return "ok";
  if (metric.warn == null && metric.crit == null) return "ok";

  const comparator = comparatorFor(metric);
  if (breaches(comparator, value, metric.crit, metric.unit)) return "crit";
  if (breaches(comparator, value, metric.warn, metric.unit)) return "warn";
  return "ok";
}

/**
 * Where a value sits against ONE ops_alert_rules ROW's thresholds.
 *
 * Lives here, beside breaches() and severityFor(), so every threshold decision
 * in the console is made by the same file. When this logic was split between
 * registry.ts (page colouring) and alerts.ts (the engine), the copies drifted
 * and a failed job rendered a green tile while a critical alert was open.
 *
 * Crit is checked BEFORE warn: a value past both thresholds is critical, and
 * checking warn first would report the lesser severity for the worse condition.
 */
export function severityForRule(
  rule: {
    metric_key: string;
    comparator: string;
    warn_threshold: number | null;
    crit_threshold: number | null;
  },
  value: number,
): { severity: "crit" | "warn"; threshold: number } | null {
  const unit = getMetric(rule.metric_key)?.unit;
  const comparator = rule.comparator === "lt" ? "lt" : "gt";

  if (breaches(comparator, value, rule.crit_threshold, unit)) {
    return { severity: "crit", threshold: rule.crit_threshold! };
  }
  if (breaches(comparator, value, rule.warn_threshold, unit)) {
    return { severity: "warn", threshold: rule.warn_threshold! };
  }
  return null;
}

/**
 * Why a warn/crit pair is unusable, or null if it is fine.
 *
 * The same invariant __tests__/registry.test.ts enforces on METRICS, applied to
 * a hand-written ops_alert_rules row. A warn on the wrong side of crit is not a
 * cosmetic error: severityForRule checks crit FIRST, so the value trips critical
 * before it can ever be a warning, and the early warning the rule exists to give
 * is silently unreachable. Nothing on screen looks wrong.
 *
 * Only meaningful when both are set — a rule may legitimately warn but never
 * escalate, or escalate with no warning step.
 */
export function thresholdOrderError(
  comparator: string,
  warn: number | null | undefined,
  crit: number | null | undefined,
): string | null {
  if (warn == null || crit == null) return null;

  if (comparator === "lt") {
    // Fires BELOW the threshold (higher is better), so the value falls through
    // warn on its way to crit — warn must sit above it.
    return warn >= crit
      ? null
      : "warn must be at or above crit for a 'lt' rule, which fires below its threshold — otherwise the value hits crit first and warn can never fire";
  }

  // Fires ABOVE the threshold (lower is better): the value rises through warn.
  return warn <= crit
    ? null
    : "warn must be at or below crit for a 'gt' rule, which fires above its threshold — otherwise the value hits crit first and warn can never fire";
}
