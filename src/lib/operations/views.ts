/**
 * The read models behind /operations/infrastructure and /operations/database.
 *
 * Shared by the pages and by the matching /api/operations/* routes so the two
 * can never disagree about what "connection headroom" means. Pure reads over
 * ops_metric_samples — no vendor calls, no shelling out, no collector work.
 */

import {
  isDriverDefaultName,
  resolveApplicationName,
  type ApplicationNameSource,
} from "@/lib/db/applicationName";

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

/**
 * Connection capacity first — it is the number the whole module exists for.
 *
 * `db.connections_used` and `db.max_connections` are NOT tiles. Three tiles for
 * one measurement (a count, a ceiling, and the percentage of one over the
 * other) is the redundancy this list used to carry; the raw pair now renders as
 * subtext on the capacity tile, where it reads as "13 of 76" instead of as two
 * more numbers to scan. Both are still collected, so the history is unbroken.
 *
 * Order is render order: capacity, then throughput, then the ratios, then the
 * slow-burn maintenance numbers.
 */
const DB_METRICS = [
  "db.connections_pct",
  "db.queries_per_s",
  "db.txns_per_s",
  "db.reads_per_s",
  "db.writes_per_s",
  "db.cache_hit_pct",
  "db.rollback_pct",
  "db.deadlocks",
  "db.longest_query_s",
  "db.longest_idle_tx_s",
  "db.dead_tuple_pct",
] as const;

/**
 * Structural facts about the database, rendered as an identity strip on the
 * card rather than as tiles.
 *
 * A tile carries a threshold and a trend; these carry neither. "287 tables" is
 * not healthy or unhealthy, it is what the database IS — and giving it the same
 * visual weight as connection capacity would dilute the one number that
 * predicts an outage. Same reasoning that already keeps connections_used and
 * max_connections out of the tile grid.
 */
export interface DatabaseIdentity {
  tables: number | null;
  columns: number | null;
  size_bytes: number | null;
  /** Dead rows awaiting vacuum — context for the dead-tuple share tile. */
  dead_tuples: number | null;
  database: string | null;
  username: string | null;
  major_version: number | null;
}

/** One application/database/user/host holding client backends right now. */
export interface ConnectionClient {
  application: string;
  database: string | null;
  username: string | null;
  /** Peer address, or "local" for a Unix-socket connection on the instance. */
  client_host: string | null;
  connections: number;
  active: number;
  idle: number;
  idle_tx: number;
  /** Seconds since the longest-unchanged backend in this group last moved. */
  oldest_state_s: number | null;
  /**
   * True when `application` is a driver default rather than a service identity
   * — i.e. that process declared no name at all.
   *
   * `postgres.js` is not the name of an application; it is what every unnamed
   * postgres.js pool reports. Rendering it as though it were an identity is
   * what made this table unable to answer the one question it exists for.
   */
  is_driver_default: boolean;
}

export interface DatabaseInstanceView {
  source: string;
  label: string;
  metrics: MetricReading[];
  /** Structural facts, rendered as the card's identity strip. */
  identity: DatabaseIdentity;
  /** Set when the collector recorded a text sample instead of a number. */
  unreachable: string | null;
  /**
   * True when the instance is configured but was never probed — i.e. there is
   * no connection string for it. A deployment fact, not a fault, and rendered
   * differently from a failure.
   */
  not_configured: string | null;
  /** host:port the collector dialled, for the unreachable message. Never credentials. */
  target: string | null;
  /**
   * The raw pair behind the capacity tile: client backends, and the slots the
   * application can actually reach (max_connections − superuser_reserved).
   * Rendered as subtext rather than as two more tiles.
   */
  connections_used: number | null;
  connections_usable: number | null;
  max_connections: number | null;
  /** Background workers seen — they hold no slot, and saying so avoids a "why don't these add up". */
  background_workers: number | null;
  /**
   * False when this role cannot see other roles' backends (no pg_monitor).
   * The connection count and attribution would then describe only our own
   * sessions, which is a wrong answer that looks like a right one — so the page
   * withholds them and says why instead.
   */
  can_see_all_backends: boolean;
  /** Where those connections come from. Empty when the probe found nothing. */
  clients: ConnectionClient[];
  /** Largest tables on THIS instance. */
  tables: TableRow[];
}

/** Narrow one entry of the collector's `clients` meta array. */
function parseClient(raw: unknown): ConnectionClient | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.application !== "string") return null;
  // Every field added after the first release is optional here on purpose: a
  // sample written by the previous collector must still render, rather than
  // blanking the table for one collection interval after each deploy.
  return {
    application: r.application,
    database: typeof r.database === "string" ? r.database : null,
    username: typeof r.username === "string" ? r.username : null,
    client_host: typeof r.client_host === "string" ? r.client_host : null,
    connections: typeof r.connections === "number" ? r.connections : 0,
    active: typeof r.active === "number" ? r.active : 0,
    idle: typeof r.idle === "number" ? r.idle : 0,
    idle_tx: typeof r.idle_tx === "number" ? r.idle_tx : 0,
    oldest_state_s:
      typeof r.oldest_state_s === "number" ? r.oldest_state_s : null,
    // Derived here rather than stored by the collector: it is a property of the
    // NAME, not a new measurement, so recomputing it on read keeps the stored
    // sample unchanged and lets the list of known defaults grow without a
    // migration or a wait for the next collection cycle.
    is_driver_default: isDriverDefaultName(r.application),
  };
}

export interface TableRow {
  name: string;
  bytes: number | null;
  rows: number | null;
}

export interface DatabaseView {
  instances: DatabaseInstanceView[];
  drift: {
    count: number | null;
    missing: string[];
    unavailable: string | null;
  };
  /**
   * What THIS process announces to Postgres, and which input supplied it.
   *
   * Read live rather than from a sample: the page renders in the same process
   * that owns the pool, so this is a fact about the running server, not a
   * measurement that could be stale.
   *
   * It exists because "the table still says postgres.js" has two completely
   * different causes — the env change has not reached this box yet, or the box
   * genuinely has nothing to declare — and from the outside they look
   * identical. Naming the source distinguishes them without a shell.
   */
  this_process: {
    application_name: string | null;
    source: ApplicationNameSource;
  };
  last_updated: Date | null;
}

const INSTANCE_LABELS: Record<string, string> = {
  "rds:crm": "CRM database",
  "rds:iot": "IoT database",
};

/**
 * Which `source` prefix carries per-table samples for each instance.
 *
 * The collector writes CRM tables as `table:<name>` and IoT tables as
 * `iot_table:<name>`. Without this split the telemetry database's tables would
 * be listed under the CRM card, which is how "largest tables" becomes a lie.
 */
const TABLE_PREFIXES: Record<string, string> = {
  "rds:crm": "table:",
  "rds:iot": "iot_table:",
};

/** The instances the page always shows a card for, in render order. */
const KNOWN_INSTANCES = ["rds:crm", "rds:iot"] as const;

export async function getDatabaseView(): Promise<DatabaseView> {
  const metricKeys = [
    ...DB_METRICS,
    "db.reachable",
    "db.table_count",
    "db.column_count",
    "db.dead_tuples",
    "db.size_bytes",
    "db.connections_used",
    "db.max_connections",
    "db.connection_sources",
    "db.migration_drift",
    "db.table_bytes",
    "db.table_rows",
  ];

  const [samples, series] = await Promise.all([
    latestSamples(metricKeys, { maxAgeHours: 48 }),
    seriesFor(
      [
        "db.connections_pct",
        "db.cache_hit_pct",
        "db.queries_per_s",
        "db.txns_per_s",
        "db.reads_per_s",
        "db.writes_per_s",
      ],
      { hours: 24 },
    ),
  ]);
  const index = bySourceKey(samples);

  // Per-instance table lists, keyed by the prefix each instance's samples use.
  const tablesFor = (prefix: string): TableRow[] => {
    const names = [
      ...new Set(
        samples
          .filter(
            (s) =>
              s.source.startsWith(prefix) &&
              (s.metric_key === "db.table_bytes" ||
                s.metric_key === "db.table_rows"),
          )
          .map((s) => s.source.slice(prefix.length)),
      ),
    ];
    return names
      .map((name) => ({
        name,
        bytes: index.get(`db.table_bytes|${prefix}${name}`)?.value_num ?? null,
        rows: index.get(`db.table_rows|${prefix}${name}`)?.value_num ?? null,
      }))
      .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  };

  // Always render a card per known instance, plus anything else that has
  // written samples. An instance that vanishes from the list because nothing
  // was collected reads as "nothing to report" when it means "we never looked".
  const instanceSources = [
    ...new Set([
      ...KNOWN_INSTANCES,
      ...samples
        .filter((s) => s.source.startsWith("rds:"))
        .map((s) => s.source),
    ]),
  ].sort(
    (a, b) =>
      (KNOWN_INSTANCES.indexOf(a as (typeof KNOWN_INSTANCES)[number]) + 1 ||
        99) -
      (KNOWN_INSTANCES.indexOf(b as (typeof KNOWN_INSTANCES)[number]) + 1 || 99),
  );

  const instances: DatabaseInstanceView[] = instanceSources.map((source) => {
    const reachSample = index.get(`db.reachable|${source}`);
    const connSample = index.get(`db.connections_used|${source}`);

    // Three distinct states, and conflating any two of them is how this page
    // previously misled. `db.reachable` is authoritative where present; the
    // connections fallback keeps a card rendering against samples written by
    // the previous collector.
    const notConfigured =
      reachSample?.value_num == null && reachSample?.value_text?.startsWith("not configured")
        ? reachSample.value_text
        : null;
    const unreachable =
      notConfigured != null
        ? null
        : reachSample?.value_num === 0 && reachSample.value_text
          ? reachSample.value_text
          : connSample?.value_num == null && connSample?.value_text
            ? connSample.value_text
            : null;

    const target =
      typeof reachSample?.meta?.target === "string"
        ? (reachSample.meta.target as string)
        : null;

    // Usable slots come from the connections sample's own meta, so the tile's
    // subtext and the percentage above it are always computed from the same
    // reading — a separately-fetched max_connections could be one cycle older
    // and make "13 of 76" disagree with the percentage beside it.
    const usable =
      typeof connSample?.meta?.usable === "number"
        ? (connSample.meta.usable as number)
        : null;

    // Absent on samples written before the capability probe existed. Defaulting
    // to TRUE there is deliberate: the only instance that has ever written such
    // samples is the CRM, whose role does hold pg_monitor (verified), and
    // defaulting to false would hide a correct connection table.
    const canSeeAll =
      typeof connSample?.meta?.can_see_all_backends === "boolean"
        ? (connSample.meta.can_see_all_backends as boolean)
        : true;

    const sourcesSample = index.get(`db.connection_sources|${source}`);
    const clientsMeta = sourcesSample?.meta?.clients;
    const clients = Array.isArray(clientsMeta)
      ? clientsMeta
          .map(parseClient)
          .filter((c): c is ConnectionClient => c !== null)
          .sort((a, b) => b.connections - a.connections)
      : [];

    return {
      source,
      label: INSTANCE_LABELS[source] ?? source,
      unreachable,
      not_configured: notConfigured,
      target,
      identity: {
        tables: index.get(`db.table_count|${source}`)?.value_num ?? null,
        columns: index.get(`db.column_count|${source}`)?.value_num ?? null,
        size_bytes: index.get(`db.size_bytes|${source}`)?.value_num ?? null,
        dead_tuples: index.get(`db.dead_tuples|${source}`)?.value_num ?? null,
        database:
          typeof reachSample?.meta?.database === "string"
            ? (reachSample.meta.database as string)
            : null,
        username:
          typeof reachSample?.meta?.username === "string"
            ? (reachSample.meta.username as string)
            : null,
        major_version:
          typeof reachSample?.meta?.major_version === "number"
            ? (reachSample.meta.major_version as number)
            : null,
      },
      connections_used: connSample?.value_num ?? null,
      connections_usable: usable,
      max_connections:
        index.get(`db.max_connections|${source}`)?.value_num ?? null,
      background_workers:
        typeof connSample?.meta?.background_workers === "number"
          ? (connSample.meta.background_workers as number)
          : null,
      can_see_all_backends: canSeeAll,
      clients: canSeeAll ? clients : [],
      tables: tablesFor(TABLE_PREFIXES[source] ?? `${source}:`),
      metrics: DB_METRICS.map((key) =>
        reading(
          key,
          index.get(`${key}|${source}`),
          series.get(`${key}|${source}`),
        ),
      ).filter((m): m is MetricReading => m !== null),
    };
  });

  const driftSample = index.get("db.migration_drift|rds:crm");
  const driftMissing = Array.isArray(driftSample?.meta?.missing)
    ? (driftSample.meta.missing as string[])
    : [];

  const lastUpdated = samples.reduce<Date | null>(
    (newest, s) =>
      newest == null || s.captured_at > newest ? s.captured_at : newest,
    null,
  );

  const self = resolveApplicationName();

  return {
    instances,
    this_process: {
      application_name: self.name ?? null,
      source: self.source,
    },
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
