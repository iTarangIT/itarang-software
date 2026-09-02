/**
 * The read model behind /operations/alerts.
 *
 * Kept apart from ./alerts.ts on purpose: that module is the ENGINE and runs on
 * the ticker; this one only reads. Mixing them would put page-shaped queries in
 * the hot path of something that runs every 60 seconds.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

import { ANY_SOURCE } from "./alertRouting";
import { comparatorFor, getMetric } from "./registry";

export interface AlertRow {
  id: string;
  metric_key: string;
  label: string;
  source: string;
  severity: string;
  status: string;
  value_num: number | null;
  threshold: number | null;
  unit: string;
  message: string;
  opened_at: Date;
  resolved_at: Date | null;
  acknowledged_at: Date | null;
  notified_at: Date | null;
}

export interface RuleRow {
  id: string;
  metric_key: string;
  label: string;
  source: string;
  comparator: string;
  warn_threshold: number | null;
  crit_threshold: number | null;
  enabled: boolean;
  cooldown_minutes: number;
  notify_channels: string[];
  unit: string;
  help?: string;
}

/**
 * A metric an override can be created for, with the sources actually reporting.
 *
 * The source list is observed, not guessed: a free-text box invites a typo like
 * "vendor:eleven_labs", which produces a rule that silently matches nothing
 * while looking correct on the page.
 */
export interface MetricOption {
  metric_key: string;
  label: string;
  unit: string;
  /** Derived from the metric's direction — 'lt' fires below, 'gt' above. */
  comparator: string;
  help?: string;
  /** Sources seen in the last 48h that do NOT already have an override. */
  sources: string[];
  /** The '*' rule's current thresholds, to prefill the form sensibly. */
  default_warn: number | null;
  default_crit: number | null;
}

export interface AlertsView {
  open: AlertRow[];
  recent_resolved: AlertRow[];
  rules: RuleRow[];
  /** Only metrics with at least one source still available to override. */
  metric_options: MetricOption[];
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function toAlert(r: Record<string, unknown>): AlertRow {
  const key = String(r.metric_key);
  const def = getMetric(key);
  return {
    id: String(r.id),
    metric_key: key,
    label: def?.label ?? key,
    source: String(r.source),
    severity: String(r.severity),
    status: String(r.status),
    value_num: num(r.value_num),
    threshold: num(r.threshold),
    unit: def?.unit ?? "count",
    message: String(r.message),
    opened_at: new Date(r.opened_at as string),
    resolved_at: r.resolved_at ? new Date(r.resolved_at as string) : null,
    acknowledged_at: r.acknowledged_at ? new Date(r.acknowledged_at as string) : null,
    notified_at: r.notified_at ? new Date(r.notified_at as string) : null,
  };
}

export async function getAlertsView(): Promise<AlertsView> {
  const [openRows, resolvedRows, ruleRows, sourceRows] = await Promise.all([
    // Critical first, then newest. Same ordering as the board's alert strip so
    // the two pages tell the same story.
    db.execute(sql`
      SELECT id, metric_key, source, severity, status, value_num, threshold,
             message, opened_at, resolved_at, acknowledged_at, notified_at
      FROM ops_alerts
      WHERE resolved_at IS NULL
      ORDER BY (severity = 'crit') DESC, opened_at DESC
      LIMIT 100
    `),

    // A short resolved history: "did that thing come back?" is the second
    // question anyone asks, and without it a recovered alert vanishes without
    // trace.
    db.execute(sql`
      SELECT id, metric_key, source, severity, status, value_num, threshold,
             message, opened_at, resolved_at, acknowledged_at, notified_at
      FROM ops_alerts
      WHERE resolved_at IS NOT NULL
      ORDER BY resolved_at DESC
      LIMIT 20
    `),

    db.execute(sql`
      SELECT id, metric_key, source, comparator, warn_threshold, crit_threshold,
             enabled, cooldown_minutes, notify_channels
      FROM ops_alert_rules
      ORDER BY metric_key, source
    `),

    // Which (metric, source) pairs are actually live, for the override picker.
    //
    // 48 hours, not 7 days: it bounds the scan on a table that keeps 30 days of
    // samples and is re-read every 30 seconds by this page's auto-refresh, and
    // the slowest collector runs hourly — so anything still collecting appears.
    // A source that stopped reporting two days ago is not one you want to be
    // writing new thresholds against anyway.
    db.execute(sql`
      SELECT DISTINCT metric_key, source
      FROM ops_metric_samples
      WHERE captured_at > NOW() - INTERVAL '48 hours'
      ORDER BY metric_key, source
    `),
  ]);

  const rows = (r: unknown) => r as unknown as Array<Record<string, unknown>>;

  const ruleList = rows(ruleRows);

  // Sources already carrying an override — offering them again would just
  // produce a 409 from the API.
  const claimed = new Set(
    ruleList
      .filter((r) => String(r.source) !== ANY_SOURCE)
      .map((r) => `${String(r.metric_key)}|${String(r.source)}`),
  );

  const wildcard = new Map(
    ruleList
      .filter((r) => String(r.source) === ANY_SOURCE)
      .map((r) => [String(r.metric_key), r]),
  );

  const byMetric = new Map<string, string[]>();
  for (const r of rows(sourceRows)) {
    const key = String(r.metric_key);
    const source = String(r.source);
    if (claimed.has(`${key}|${source}`)) continue;
    // A metric the registry does not declare cannot be rendered — no label, no
    // unit, no comparator — so it cannot be offered either.
    if (!getMetric(key)) continue;
    byMetric.set(key, [...(byMetric.get(key) ?? []), source]);
  }

  const metricOptions: MetricOption[] = [...byMetric.entries()]
    .map(([key, sources]): MetricOption => {
      const def = getMetric(key)!;
      const base = wildcard.get(key);
      return {
        metric_key: key,
        label: def.label,
        unit: def.unit,
        comparator: comparatorFor(def),
        help: def.help,
        sources,
        default_warn: num(base?.warn_threshold) ?? def.warn ?? null,
        default_crit: num(base?.crit_threshold) ?? def.crit ?? null,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  return {
    open: rows(openRows).map(toAlert),
    recent_resolved: rows(resolvedRows).map(toAlert),
    metric_options: metricOptions,
    rules: ruleList.map((r): RuleRow => {
      const key = String(r.metric_key);
      const def = getMetric(key);
      return {
        id: String(r.id),
        metric_key: key,
        label: def?.label ?? key,
        source: String(r.source),
        comparator: String(r.comparator),
        warn_threshold: num(r.warn_threshold),
        crit_threshold: num(r.crit_threshold),
        enabled: r.enabled === true,
        cooldown_minutes: Number(r.cooldown_minutes ?? 60),
        notify_channels: Array.isArray(r.notify_channels)
          ? (r.notify_channels as string[])
          : ["inapp"],
        unit: def?.unit ?? "count",
        help: def?.help,
      };
    }),
  };
}
