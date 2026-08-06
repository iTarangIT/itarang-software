/**
 * The read models behind /operations/infrastructure and /operations/database.
 *
 * Shared by the pages and by the matching /api/operations/* routes so the two
 * can never disagree about what "connection headroom" means. Pure reads over
 * ops_metric_samples — no vendor calls, no shelling out, no collector work.
 */

import { configuredHosts } from "./collectors/host";
import {
  getMetric,
  severityFor,
  type MetricDef,
  type Severity,
} from "./registry";
import {
  bySourceKey,
  latestSamples,
  seriesFor,
  sourcesFor,
  type LatestSample,
  type SeriesPoint,
} from "./samples";

export interface MetricReading {
  key: string;
  label: string;
  unit: MetricDef["unit"];
  help?: string;
  value: number | null;
  text: string | null;
  severity: Severity;
  captured_at: Date | null;
  age_minutes: number | null;
  warn?: number;
  crit?: number;
  series: SeriesPoint[];
}

function reading(
  key: string,
  sample: LatestSample | undefined,
  series: SeriesPoint[] = [],
): MetricReading | null {
  const def = getMetric(key);
  // A metric a collector writes but the registry does not declare has no label,
  // no unit and no thresholds — it cannot be rendered, and silently inventing a
  // default would hide the registry gap that caused it.
  if (!def) return null;

  return {
    key,
    label: def.label,
    unit: def.unit,
    help: def.help,
    value: sample?.value_num ?? null,
    text: sample?.value_text ?? null,
    severity: severityFor(def, sample?.value_num),
    captured_at: sample?.captured_at ?? null,
    age_minutes: sample?.age_minutes ?? null,
    warn: def.warn,
    crit: def.crit,
    series,
  };
}

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

/** Order matters — this is the order the tiles render in. */
const HOST_METRICS = [
  "host.cpu_pct",
  "host.mem_used_pct",
  "host.disk_used_pct",
  "host.disk_free_gb",
  "host.swap_used_pct",
  "host.inode_used_pct",
  "host.load1",
  "host.cert_days_left",
  "host.uptime_s",
] as const;

const PROCESS_METRICS = [
  "process.online",
  "process.restarts",
  "process.mem_mb",
] as const;

export interface ProcessRow {
  name: string;
  source: string;
  status: string | null;
  online: boolean | null;
  restarts: number | null;
  mem_mb: number | null;
  cpu_pct: number | null;
  uptime_s: number | null;
  /** Against prod's 900M max_memory_restart ceiling. */
  mem_severity: Severity;
}

export interface HostView {
  host: string;
  /** Minutes since this host last POSTed; null when it never has. */
  agent_age_minutes: number | null;
  agent_severity: Severity;
  never_reported: boolean;
  metrics: MetricReading[];
  processes: ProcessRow[];
}

export interface InfrastructureView {
  hosts: HostView[];
  /** Hosts named in OPS_INGEST_HOSTS. Empty means ingest is unconfigured. */
  configured: string[];
}

/**
 * `proc:<host>:<name>` → its two parts.
 *
 * Split on the first two colons only: a pm2 process name is free text and may
 * contain one, and splitting greedily would file `web:api` under host `web`.
 */
function parseProcessSource(
  source: string,
): { host: string; name: string } | null {
  const match = source.match(/^proc:([^:]+):(.+)$/);
  if (!match) return null;
  return { host: match[1]!, name: match[2]! };
}

export async function getInfrastructureView(): Promise<InfrastructureView> {
  const configured = configuredHosts();

  const metricKeys = [
    ...HOST_METRICS,
    ...PROCESS_METRICS,
    "host.agent_age_min",
  ];

  const [samples, series] = await Promise.all([
    latestSamples(metricKeys, { maxAgeHours: 48 }),
    // Only the tiles get a sparkline. Process metrics are a table, and pulling
    // 24h of history for every pm2 process on every box would dominate the
    // query for something nothing renders.
    seriesFor([...HOST_METRICS], { hours: 24 }),
  ]);

  const index = bySourceKey(samples);

  // Union of configured hosts and hosts that have actually reported. A host
  // that was removed from OPS_INGEST_HOSTS but still has recent samples should
  // stay visible until its data ages out, rather than disappearing mid-incident.
  const reported = sourcesFor(samples, "host.agent_age_min")
    .concat(sourcesFor(samples, "host.cpu_pct"))
    .map((s) => s.replace(/^host:/, ""));
  const hostNames = [...new Set([...configured, ...reported])].sort();

  const processesByHost = new Map<string, ProcessRow[]>();
  for (const source of sourcesFor(samples, "process.online")) {
    const parsed = parseProcessSource(source);
    if (!parsed) continue;

    const online = index.get(`process.online|${source}`);
    const restarts = index.get(`process.restarts|${source}`);
    const mem = index.get(`process.mem_mb|${source}`);
    const memDef = getMetric("process.mem_mb");

    const row: ProcessRow = {
      name: parsed.name,
      source,
      status: online?.value_text ?? null,
      online: online?.value_num == null ? null : online.value_num >= 1,
      restarts: restarts?.value_num ?? null,
      mem_mb: mem?.value_num ?? null,
      cpu_pct:
        typeof mem?.meta?.cpu_pct === "number" ? (mem.meta.cpu_pct as number) : null,
      uptime_s:
        typeof online?.meta?.uptime_s === "number"
          ? (online.meta.uptime_s as number)
          : null,
      mem_severity: memDef
        ? severityFor(memDef, mem?.value_num)
        : ("unknown" as Severity),
    };

    const list = processesByHost.get(parsed.host) ?? [];
    list.push(row);
    processesByHost.set(parsed.host, list);
  }

  const hosts: HostView[] = hostNames.map((host) => {
    const source = `host:${host}`;
    const agent = index.get(`host.agent_age_min|${source}`);
    const agentDef = getMetric("host.agent_age_min");
    const neverReported = agent?.value_text === "never reported";

    return {
      host,
      agent_age_minutes: neverReported ? null : (agent?.value_num ?? null),
      agent_severity: agentDef
        ? severityFor(agentDef, agent?.value_num)
        : ("unknown" as Severity),
      never_reported: neverReported || agent == null,
      metrics: HOST_METRICS.map((key) =>
        reading(key, index.get(`${key}|${source}`), series.get(`${key}|${source}`)),
      ).filter((m): m is MetricReading => m !== null),
      processes: (processesByHost.get(host) ?? []).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    };
  });

  return { hosts, configured };
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** Connection headroom first — it is the number the whole module exists for. */
const DB_METRICS = [
  "db.connections_pct",
  "db.connections_used",
  "db.max_connections",
  "db.cache_hit_pct",
  "db.longest_query_s",
  "db.longest_idle_tx_s",
  "db.rollback_pct",
  "db.deadlocks",
  "db.dead_tuples",
  "db.size_bytes",
] as const;

export interface DatabaseInstanceView {
  source: string;
  label: string;
  metrics: MetricReading[];
  /** Set when the collector recorded a text sample instead of a number. */
  unreachable: string | null;
}

export interface TableRow {
  name: string;
  bytes: number | null;
  rows: number | null;
}

export interface DatabaseView {
  instances: DatabaseInstanceView[];
  tables: TableRow[];
  drift: {
    count: number | null;
    missing: string[];
    unavailable: string | null;
  };
  last_updated: Date | null;
}

const INSTANCE_LABELS: Record<string, string> = {
  "rds:crm": "CRM RDS (database-1 / database-2)",
  "rds:iot": "IoT bridge (VPS Postgres)",
};

export async function getDatabaseView(): Promise<DatabaseView> {
  const metricKeys = [
    ...DB_METRICS,
    "db.migration_drift",
    "db.table_bytes",
    "db.table_rows",
  ];

  const [samples, series] = await Promise.all([
    latestSamples(metricKeys, { maxAgeHours: 48 }),
    seriesFor(["db.connections_pct", "db.connections_used", "db.cache_hit_pct"], {
      hours: 24,
    }),
  ]);
  const index = bySourceKey(samples);

  const instanceSources = [
    ...new Set(
      samples
        .filter((s) => s.source.startsWith("rds:"))
        .map((s) => s.source),
    ),
  ].sort();

  const instances: DatabaseInstanceView[] = instanceSources.map((source) => {
    const connSample = index.get(`db.connections_used|${source}`);
    // The collector records an unreachable database as a text sample with a
    // null value, so an empty column reads as "unreachable", not as "fine".
    const unreachable =
      connSample?.value_num == null && connSample?.value_text
        ? connSample.value_text
        : null;

    return {
      source,
      label: INSTANCE_LABELS[source] ?? source,
      unreachable,
      metrics: DB_METRICS.map((key) =>
        reading(key, index.get(`${key}|${source}`), series.get(`${key}|${source}`)),
      ).filter((m): m is MetricReading => m !== null),
    };
  });

  // Table sizes are written with source `table:<name>`.
  const tableNames = [
    ...new Set(
      samples
        .filter(
          (s) =>
            s.source.startsWith("table:") &&
            (s.metric_key === "db.table_bytes" || s.metric_key === "db.table_rows"),
        )
        .map((s) => s.source.slice("table:".length)),
    ),
  ];

  const tables: TableRow[] = tableNames
    .map((name) => ({
      name,
      bytes: index.get(`db.table_bytes|table:${name}`)?.value_num ?? null,
      rows: index.get(`db.table_rows|table:${name}`)?.value_num ?? null,
    }))
    .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));

  const driftSample = index.get("db.migration_drift|rds:crm");
  const driftMissing = Array.isArray(driftSample?.meta?.missing)
    ? (driftSample.meta.missing as string[])
    : [];

  const lastUpdated = samples.reduce<Date | null>(
    (newest, s) =>
      newest == null || s.captured_at > newest ? s.captured_at : newest,
    null,
  );

  return {
    instances,
    tables,
    drift: {
      count: driftSample?.value_num ?? null,
      missing: driftMissing,
      unavailable:
        driftSample?.value_num == null && driftSample?.value_text
          ? driftSample.value_text
          : null,
    },
    last_updated: lastUpdated,
  };
}
