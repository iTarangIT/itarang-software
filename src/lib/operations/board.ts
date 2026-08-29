/**
 * The read model behind /operations — the one-slide board.
 *
 * Designed to be screenshotted for standup: one screen, no scrolling, no
 * interaction needed. That constraint is what keeps `onSlide` short in
 * registry.ts, and it is why this returns a flat tile list rather than a
 * nested per-module structure the page would have to lay out.
 *
 * Each tile carries yesterday's FROZEN value alongside the live one. The pair
 * is what makes a number readable at a glance: 74% disk means nothing on its
 * own, but 74% today against 61% yesterday is a trend worth acting on before
 * it becomes an incident.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

import { getSnapshotFor, previousIstDate } from "./daily";
import { severityFor, slideMetrics, type MetricDef, type Severity } from "./registry";
import { getMonitorFreshness } from "./runner";
import { latestSamples } from "./samples";

export interface BoardTile {
  key: string;
  label: string;
  unit: MetricDef["unit"];
  help?: string;
  source: string;
  value: number | null;
  severity: Severity;
  /** Yesterday's frozen value for the same metric+source, if it exists. */
  yesterday: number | null;
  age_minutes: number | null;
}

export interface OpenAlertSummary {
  crit: number;
  warn: number;
  total: number;
  /** The most recent few, for the board's alert strip. */
  newest: Array<{
    metric_key: string;
    source: string;
    severity: string;
    message: string;
    opened_at: Date;
    acknowledged: boolean;
  }>;
}

export interface DeployInfo {
  source: string;
  commit: string;
  node_env: string | null;
  uptime_s: number | null;
}

export interface BoardView {
  tiles: BoardTile[];
  alerts: OpenAlertSummary;
  deploys: DeployInfo[];
  /** True when environments are on different commits. */
  deploy_mismatch: boolean;
  freshness: { last_completed_at: Date | null; minutes_ago: number | null };
  snapshot_date: string;
}

export async function getBoardView(): Promise<BoardView> {
  const slide = slideMetrics();
  const keys = slide.map((m) => m.key);
  const yesterday = previousIstDate();

  const [samples, snapshot, alertRows, newestAlerts, deployRows, freshness] =
    await Promise.all([
      latestSamples(keys, { maxAgeHours: 24 }),
      getSnapshotFor(yesterday),

      db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE severity = 'crit')::int AS crit,
          COUNT(*) FILTER (WHERE severity = 'warn')::int AS warn,
          COUNT(*)::int                                  AS total
        FROM ops_alerts WHERE resolved_at IS NULL
      `),

      db.execute(sql`
        SELECT metric_key, source, severity, message, opened_at,
               acknowledged_at IS NOT NULL AS acknowledged
        FROM ops_alerts
        WHERE resolved_at IS NULL
        ORDER BY (severity = 'crit') DESC, opened_at DESC
        LIMIT 5
      `),

      // Deploy SHA per environment. app.uptime_s carries the commit in meta —
      // stamped by the app-health collector from GITHUB_SHA, so it describes
      // the process that is actually serving, not what a config file claims.
      db.execute(sql`
        SELECT DISTINCT ON (source) source, value_num, meta
        FROM ops_metric_samples
        WHERE metric_key = 'app.uptime_s'
          AND captured_at > NOW() - INTERVAL '24 hours'
        ORDER BY source, captured_at DESC
      `),

      getMonitorFreshness(),
    ]);

  // One tile per (metric, source) pair that actually reported. A slide metric
  // with three hosts becomes three tiles; one with no data becomes none, so the
  // board never shows an empty box for a host that does not exist here.
  const tiles: BoardTile[] = [];
  for (const def of slide) {
    const forMetric = samples.filter((s) => s.metric_key === def.key);
    for (const sample of forMetric) {
      tiles.push({
        key: def.key,
        label: def.label,
        unit: def.unit,
        help: def.help,
        source: sample.source,
        value: sample.value_num,
        severity: severityFor(def, sample.value_num),
        yesterday:
          snapshot.get(`${def.key}|${sample.source}`)?.value_num ?? null,
        age_minutes: sample.age_minutes,
      });
    }
  }

  // Worst first. A board you have to scan for the red tile has failed at its
  // one job.
  const rank: Record<Severity, number> = { crit: 0, warn: 1, unknown: 2, ok: 3 };
  tiles.sort(
    (a, b) => rank[a.severity] - rank[b.severity] || a.label.localeCompare(b.label),
  );

  const counts = (alertRows as unknown as Array<Record<string, unknown>>)[0];
  const deploys = (deployRows as unknown as Array<Record<string, unknown>>).map(
    (r): DeployInfo => {
      const meta = (r.meta ?? {}) as Record<string, unknown>;
      return {
        source: String(r.source),
        commit: typeof meta.commit === "string" ? meta.commit : "unknown",
        node_env: typeof meta.node_env === "string" ? meta.node_env : null,
        uptime_s: r.value_num == null ? null : Number(r.value_num),
      };
    },
  );

  const knownCommits = new Set(
    deploys.map((d) => d.commit).filter((c) => c && c !== "unknown"),
  );

  return {
    tiles,
    alerts: {
      crit: Number(counts?.crit ?? 0),
      warn: Number(counts?.warn ?? 0),
      total: Number(counts?.total ?? 0),
      newest: (newestAlerts as unknown as Array<Record<string, unknown>>).map(
        (r) => ({
          metric_key: String(r.metric_key),
          source: String(r.source),
          severity: String(r.severity),
          message: String(r.message),
          opened_at: new Date(r.opened_at as string),
          acknowledged: r.acknowledged === true,
        }),
      ),
    },
    deploys,
    deploy_mismatch: knownCommits.size > 1,
    freshness,
    snapshot_date: yesterday,
  };
}
