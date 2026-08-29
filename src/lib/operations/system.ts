/**
 * The read model behind /operations/system — the application's own vital signs.
 *
 * Everything here already exists in ops_metric_samples; this module only
 * reshapes it. No new collector, no new query against the app's own tables —
 * which is the point: the page that tells you whether the app is healthy must
 * not itself depend on the app being healthy.
 *
 * Uptime % is computed over the raw samples rather than stored, because
 * "up 98% of the last 24h" is a property of the window you ask about, not a
 * number that can be frozen once a day.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

import { toNumber } from "./format";
import { getMetric, severityFor, type Severity } from "./registry";
import { getCollectorHealth, type CollectorHealth } from "./runner";
import { bySourceKey, latestSamples, seriesFor, type SeriesPoint } from "./samples";

export interface DependencyRow {
  name: string;
  ok: boolean | null;
  detail: string | null;
  latency_ms: number | null;
  latency_severity: Severity;
  /** Share of samples in the window where the dependency was up, 0-100. */
  uptime_pct: number | null;
  samples: number;
  latency_series: SeriesPoint[];
  age_minutes: number | null;
}

export interface JobRow {
  job: string;
  label: string;
  age_minutes: number | null;
  age_severity: Severity;
  failed: boolean | null;
  error: string | null;
  unavailable: string | null;
}

export interface DeployRow {
  source: string;
  commit: string;
  node_env: string | null;
  uptime_s: number | null;
  pid: number | null;
}

export interface SystemView {
  dependencies: DependencyRow[];
  jobs: JobRow[];
  deploys: DeployRow[];
  deploy_mismatch: boolean;
  redis: {
    circuit_open: boolean | null;
    reopen_at: string | null;
    worker_enabled: boolean | null;
    age_minutes: number | null;
  } | null;
  collectors: CollectorHealth[];
  window_hours: number;
}

const WINDOW_HOURS = 24;

export async function getSystemView(): Promise<SystemView> {
  const keys = [
    "app.dep_ok",
    "app.dep_latency_ms",
    "app.health_ok",
    "app.health_latency_ms",
    "app.redis_circuit_open",
    "app.uptime_s",
    "job.last_run_age_min",
    "job.last_run_failed",
  ];

  const [samples, series, uptimeRows, deployRows, collectors] = await Promise.all([
    latestSamples(keys, { maxAgeHours: 48 }),
    seriesFor(["app.dep_latency_ms"], { hours: WINDOW_HOURS, bucketMinutes: 30 }),

    // Uptime % per dependency over the window. AVG of a 0/1 column is the
    // fraction up — cheaper and more honest than counting outage episodes,
    // which would need a definition of how long a blip has to last to count.
    db.execute(sql`
      SELECT source,
             AVG(value_num) * 100 AS uptime_pct,
             COUNT(*)::int        AS samples
      FROM ops_metric_samples
      WHERE metric_key = 'app.dep_ok'
        AND captured_at > NOW() - MAKE_INTERVAL(hours => ${WINDOW_HOURS})
        AND value_num IS NOT NULL
      GROUP BY source
    `),

    db.execute(sql`
      SELECT DISTINCT ON (source) source, value_num, meta
      FROM ops_metric_samples
      WHERE metric_key = 'app.uptime_s'
        AND captured_at > NOW() - MAKE_INTERVAL(hours => ${WINDOW_HOURS})
      ORDER BY source, captured_at DESC
    `),

    // The collectors table, reused verbatim from /operations/jobs. "Is the
    // monitoring alive?" belongs on the page about the app's own health too.
    getCollectorHealth().catch(() => [] as CollectorHealth[]),
  ]);

  const index = bySourceKey(samples);
  const rows = (r: unknown) => r as unknown as Array<Record<string, unknown>>;

  const uptimeBySource = new Map(
    rows(uptimeRows).map((r) => [
      String(r.source),
      { pct: toNumber(r.uptime_pct), samples: Number(r.samples ?? 0) },
    ]),
  );

  const latencyDef = getMetric("app.dep_latency_ms");

  const dependencies: DependencyRow[] = samples
    .filter((s) => s.metric_key === "app.dep_ok")
    .map((s) => {
      const latency = index.get(`app.dep_latency_ms|${s.source}`);
      const uptime = uptimeBySource.get(s.source);
      return {
        name: s.source.replace(/^dep:/, ""),
        ok: s.value_num == null ? null : s.value_num >= 1,
        // The collector stores "ok" or the failure reason here.
        detail: s.value_text && s.value_text !== "ok" ? s.value_text : null,
        latency_ms: latency?.value_num ?? null,
        latency_severity: latencyDef
          ? severityFor(latencyDef, latency?.value_num)
          : ("unknown" as Severity),
        uptime_pct: uptime?.pct ?? null,
        samples: uptime?.samples ?? 0,
        latency_series: series.get(`app.dep_latency_ms|${s.source}`) ?? [],
        age_minutes: s.age_minutes,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const ageDef = getMetric("job.last_run_age_min");

  const jobs: JobRow[] = samples
    .filter((s) => s.metric_key === "job.last_run_age_min")
    .map((s) => {
      const failed = index.get(`job.last_run_failed|${s.source}`);
      const meta = (s.meta ?? {}) as Record<string, unknown>;
      return {
        job: s.source.replace(/^job:/, ""),
        label: typeof meta.label === "string" ? meta.label : s.source,
        age_minutes: s.value_num,
        age_severity: ageDef
          ? severityFor(ageDef, s.value_num)
          : ("unknown" as Severity),
        failed: failed?.value_num == null ? null : failed.value_num >= 1,
        error: failed?.value_text ?? null,
        // The collector records "unavailable: relation ... does not exist" when
        // a job's table is missing on this environment.
        unavailable:
          s.value_num == null && s.value_text ? s.value_text : null,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const deploys: DeployRow[] = rows(deployRows).map((r) => {
    const meta = (r.meta ?? {}) as Record<string, unknown>;
    return {
      source: String(r.source),
      commit: typeof meta.commit === "string" ? meta.commit : "unknown",
      node_env: typeof meta.node_env === "string" ? meta.node_env : null,
      uptime_s: toNumber(r.value_num),
      pid: typeof meta.pid === "number" ? meta.pid : null,
    };
  });

  const knownCommits = new Set(
    deploys.map((d) => d.commit).filter((c) => c && c !== "unknown"),
  );

  const circuit = index.get("app.redis_circuit_open|dep:upstash");
  const circuitMeta = (circuit?.meta ?? {}) as Record<string, unknown>;

  return {
    dependencies,
    jobs,
    deploys,
    deploy_mismatch: knownCommits.size > 1,
    redis: circuit
      ? {
          circuit_open: circuit.value_num == null ? null : circuit.value_num >= 1,
          reopen_at:
            typeof circuitMeta.reopen_at === "string" ? circuitMeta.reopen_at : null,
          worker_enabled:
            typeof circuitMeta.worker_enabled === "boolean"
              ? circuitMeta.worker_enabled
              : null,
          age_minutes: circuit.age_minutes,
        }
      : null,
    collectors,
    window_hours: WINDOW_HOURS,
  };
}
