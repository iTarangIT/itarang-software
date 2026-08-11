/**
 * RDS health, by plain SQL against the databases themselves.
 *
 * No CloudWatch, no new AWS SDK client, no new IAM permission — everything here
 * comes from pg_stat_*, which any connected role can read.
 *
 * THE HIGHEST-VALUE MONITOR IN THE BUILD. src/lib/db/index.ts caps its pool at
 * `max: 5` with the note "RDS has ~79 max_connections and NO pooler; a deploy
 * burst trips 53300". When that happens /api/health fails and the deploy rolls
 * back, and today the first sign of it is the rollback. Connection headroom on
 * the board is the point of this file.
 *
 * Runs against the CRM RDS (`db`) and the IoT bridge (`getIotDb()`). Each
 * database is probed independently: the IoT bridge being unreachable — it is a
 * VPS behind a read-only role, and IOT_DATABASE_URL is not set everywhere —
 * must not cost us the CRM numbers, which are the ones that matter.
 *
 * Reuses the existing clients. A collector that opened its own pool would be
 * competing for the very connections it exists to measure.
 */

import { getTableName, is, sql, Table } from "drizzle-orm";

import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  connectionCapacityPct,
  intervalMetrics,
  type StatCounters,
} from "@/lib/operations/databaseMath";
import { rootCauseMessage } from "@/lib/operations/errors";
import { previousSample } from "@/lib/operations/samples";

import type { CollectedSample, OpsCollector } from "./types";
import { MINUTE } from "./types";

type Executor = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

async function rows(
  client: Executor,
  query: ReturnType<typeof sql>,
): Promise<Array<Record<string, unknown>>> {
  const result = await client.execute(query);
  return result as unknown as Array<Record<string, unknown>>;
}

function num(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}


/**
 * Every table name declared in schema.ts.
 *
 * `scraper_runs` is declared twice (scraperRuns and scrapeRuns, same table name,
 * divergent columns) — the Set collapses them, which is the correct behaviour
 * for a drift check even though the duplication itself is a known landmine.
 */
function declaredTables(): string[] {
  const names = new Set<string>();
  for (const value of Object.values(schema)) {
    if (is(value, Table)) names.add(getTableName(value));
  }
  return [...names];
}

/**
 * Tables in schema.ts that this database does not have — i.e. unapplied
 * migrations. Surfaces at runtime as `relation "x" does not exist`, because
 * Drizzle names every column in its INSERTs, so a missing table is a 500 on
 * the first write rather than a degraded read.
 */
async function migrationDrift(): Promise<{ count: number; missing: string[] }> {
  const declared = declaredTables();
  if (declared.length === 0) return { count: 0, missing: [] };

  const present = await rows(
    db,
    sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `,
  );
  const have = new Set(present.map((r) => String(r.table_name)));
  const missing = declared.filter((t) => !have.has(t)).sort();

  return { count: missing.length, missing };
}

/**
 * How far back a predecessor counter reading may be and still yield an
 * honest rate.
 *
 * The collector runs every 2 minutes, so this tolerates a few missed cycles.
 * It is deliberately not unbounded: "reads per second" averaged across an hour
 * of which 58 minutes were downtime is a number that describes nothing, and it
 * would land on the dashboard looking like a measurement.
 */
const MAX_COUNTER_AGE_MINUTES = 15;

interface CounterReading {
  at: Date;
  counters: StatCounters;
}

/**
 * The previous cycle's raw counters for this database, or null when there is
 * no usable predecessor.
 *
 * Always reads the CRM's ops_metric_samples (the `db` client), whichever
 * database is being PROBED — the samples table lives on the CRM RDS for every
 * source, including "rds:iot".
 */
async function previousCounters(source: string): Promise<CounterReading | null> {
  const sample = await previousSample(
    "db.stat_counters",
    source,
    MAX_COUNTER_AGE_MINUTES,
  );
  const meta = sample?.meta;
  if (!sample || !meta) return null;

  const read = (key: string): number | null => {
    const value = meta[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };

  const counters = {
    blks_hit: read("blks_hit"),
    blks_read: read("blks_read"),
    xact_commit: read("xact_commit"),
    xact_rollback: read("xact_rollback"),
    deadlocks: read("deadlocks"),
    reads: read("reads"),
    writes: read("writes"),
  };
  // A partially-written predecessor (an older shape of this meta, say) cannot
  // be differenced safely — treat it as absent rather than defaulting the
  // missing halves to zero, which would invent an enormous first delta.
  if (Object.values(counters).some((v) => v == null)) return null;

  return { at: sample.captured_at, counters: counters as CounterReading["counters"] };
}

/** Connections, query ages, cache/transaction stats and size for one database. */
async function probeDatabase(
  client: Executor,
  source: string,
): Promise<CollectedSample[]> {
  const samples: CollectedSample[] = [];

  // ---- connections -------------------------------------------------------
  // current_setting() rather than SHOW: SHOW cannot be used as a subquery, and
  // this needs every number in one round trip to be consistent with the others.
  //
  // ONLY `client backend` ROWS COUNT. pg_stat_activity also lists the
  // background workers — checkpointer, walwriter, bgwriter, archiver, the
  // autovacuum and logical-replication launchers — and those do NOT consume a
  // max_connections slot. Counting them inflated this instance's headline from
  // a true 9 to a reported 15 against a ceiling of 79: 11.4% shown as 19.0%,
  // on the one tile the whole module exists for.
  //
  // Instance-wide, not per-database, because max_connections is an INSTANCE
  // ceiling — `rdsadmin`'s own sessions occupy slots the CRM cannot have. The
  // per-database figure rides along in meta for attribution, rather than as a
  // second tile that would say almost the same thing.
  //
  // A non-superuser sees every ROW of pg_stat_activity (so the counts are
  // right) but has query/state masked for other roles' backends — which is why
  // the ages below are best-effort on the IoT bridge and exact on the CRM.
  const [conn] = await rows(
    client,
    sql`
      SELECT
        COUNT(*) FILTER (WHERE backend_type = 'client backend')     AS used,
        COUNT(*) FILTER (WHERE backend_type = 'client backend'
                           AND datname = current_database())        AS used_this_db,
        COUNT(*) FILTER (WHERE backend_type = 'client backend'
                           AND state = 'active')                    AS active,
        COUNT(*) FILTER (WHERE backend_type = 'client backend'
                           AND state = 'idle in transaction')       AS idle_tx,
        current_setting('max_connections')::int                     AS max_conn,
        current_setting('superuser_reserved_connections')::int      AS reserved
      FROM pg_stat_activity
    `,
  );
  const used = num(conn?.used);
  const maxConn = num(conn?.max_conn);
  const reserved = num(conn?.reserved) ?? 0;
  // What the application can actually reach. The reserved slots are held back
  // for superusers, so treating max_connections as the denominator overstates
  // the headroom by exactly the amount that matters during the incident this
  // metric exists to predict.
  const usable = maxConn == null ? null : maxConn - reserved;

  if (used != null) {
    samples.push({
      metric_key: "db.connections_used",
      source,
      value_num: used,
      meta: {
        this_database: num(conn?.used_this_db),
        active: num(conn?.active),
        idle_in_transaction: num(conn?.idle_tx),
        max_connections: maxConn,
        superuser_reserved: reserved,
        usable: usable,
      },
    });
  }
  if (maxConn != null) {
    samples.push({
      metric_key: "db.max_connections",
      source,
      value_num: maxConn,
    });
    const pct = connectionCapacityPct(used, maxConn, reserved);
    if (pct != null) {
      samples.push({ metric_key: "db.connections_pct", source, value_num: pct });
    }
  }

  // ---- where the connections come from ------------------------------------
  // "Identify where active connections are coming from" — answerable from
  // pg_stat_activity alone, no extra grant. application_name is what separates
  // the CRM's own pool (postgres.js) from RDS's internal sessions and from any
  // psql somebody left open.
  //
  // Stored as one sample carrying the breakdown in meta rather than one sample
  // per client: the cardinality is unbounded (every application_name ever seen
  // would become a permanent `source` in the metric table).
  const connSources = await rows(
    client,
    sql`
      SELECT
        COALESCE(NULLIF(application_name, ''), '(unnamed)') AS application,
        datname                                             AS database,
        usename                                             AS username,
        COUNT(*)::int                                       AS connections,
        COUNT(*) FILTER (WHERE state = 'active')::int       AS active
      FROM pg_stat_activity
      WHERE backend_type = 'client backend'
      GROUP BY application, database, username
      ORDER BY connections DESC
      LIMIT 20
    `,
  );
  if (connSources.length > 0) {
    samples.push({
      metric_key: "db.connection_sources",
      source,
      value_num: connSources.length,
      value_text: connSources
        .map((r) => `${String(r.application)}×${num(r.connections) ?? 0}`)
        .join(", ")
        .slice(0, 500),
      meta: {
        clients: connSources.map((r) => ({
          application: String(r.application),
          database: r.database == null ? null : String(r.database),
          username: r.username == null ? null : String(r.username),
          connections: num(r.connections) ?? 0,
          active: num(r.active) ?? 0,
        })),
      },
    });
  }

  // ---- query / transaction ages ------------------------------------------
  // Excludes this backend: the collector's own query is always the newest
  // "active" one, and counting it would put a floor under longest_query_s.
  //
  // It also excludes the OTHER Ops Console backends. runner.ts runs collectors
  // three at a time over a shared pool, so on a quiet database the longest
  // "active" query is routinely one of this console's own — the monitor
  // measuring itself and reporting it as load.
  const [ages] = await rows(
    client,
    sql`
      SELECT
        COALESCE(MAX(EXTRACT(EPOCH FROM (NOW() - query_start)))
          FILTER (WHERE state = 'active'), 0)              AS longest_query_s,
        COALESCE(MAX(EXTRACT(EPOCH FROM (NOW() - state_change)))
          FILTER (WHERE state = 'idle in transaction'), 0) AS longest_idle_tx_s
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
        AND datname = current_database()
        AND query NOT LIKE '%ops_metric_samples%'
        AND query NOT LIKE '%pg_stat_activity%'
    `,
  );
  const longestQuery = num(ages?.longest_query_s);
  const longestIdleTx = num(ages?.longest_idle_tx_s);
  if (longestQuery != null) {
    samples.push({
      metric_key: "db.longest_query_s",
      source,
      value_num: Math.round(longestQuery),
    });
  }
  if (longestIdleTx != null) {
    // Idle-in-transaction blocks autovacuum and holds locks — far more
    // dangerous than a slow query of the same age, hence its own metric.
    samples.push({
      metric_key: "db.longest_idle_tx_s",
      source,
      value_num: Math.round(longestIdleTx),
    });
  }

  // ---- cache, transactions, deadlocks, throughput, size -------------------
  // EVERY COLUMN HERE IS A COUNTER, cumulative since the last stats reset, and
  // that is the whole difficulty. This instance reports blks_hit 993,400,285
  // against blks_read 13,042 with stats_reset NULL — a lifetime ratio of
  // 100.00% that no cache collapse today could drag below the 97% warn line,
  // because the denominator is a billion blocks of history. The same is true of
  // the rollback ratio, and `deadlocks` as a level meant the tile latched red
  // on the first deadlock the database ever had and never cleared.
  //
  // So the LEVEL is not the metric — the MOVEMENT is. Each derived number below
  // is computed against the previous cycle's reading of the same counter.
  const [stat] = await rows(
    client,
    sql`
      SELECT
        blks_hit, blks_read, xact_commit, xact_rollback, deadlocks,
        tup_returned, tup_fetched,
        tup_inserted, tup_updated, tup_deleted,
        stats_reset,
        pg_database_size(current_database()) AS size_bytes
      FROM pg_stat_database
      WHERE datname = current_database()
    `,
  );

  if (stat) {
    const size = num(stat.size_bytes);
    if (size != null) {
      samples.push({ metric_key: "db.size_bytes", source, value_num: size });
    }

    const counters = {
      blks_hit: num(stat.blks_hit) ?? 0,
      blks_read: num(stat.blks_read) ?? 0,
      xact_commit: num(stat.xact_commit) ?? 0,
      xact_rollback: num(stat.xact_rollback) ?? 0,
      deadlocks: num(stat.deadlocks) ?? 0,
      reads: (num(stat.tup_returned) ?? 0) + (num(stat.tup_fetched) ?? 0),
      writes:
        (num(stat.tup_inserted) ?? 0) +
        (num(stat.tup_updated) ?? 0) +
        (num(stat.tup_deleted) ?? 0),
    };

    // The raw counters, always written, value-less. This one row is what the
    // NEXT cycle differences against — which is why it is persisted rather than
    // held in memory: an in-process previous value resets on every deploy and
    // would produce a fabricated spike on the first cycle after each release.
    // It also makes every derived number below auditable after the fact.
    samples.push({
      metric_key: "db.stat_counters",
      source,
      value_num: null,
      meta: {
        ...counters,
        stats_reset: stat.stats_reset == null ? null : String(stat.stats_reset),
      },
    });

    // The arithmetic lives in ../databaseMath.ts so its rules — omit rather
    // than zero, skip an interval whose counters went backwards — can be tested
    // without an RDS instance and a two-minute wait between readings.
    const previous = await previousCounters(source);
    const derived = intervalMetrics(
      previous?.counters ?? null,
      counters,
      previous ? (Date.now() - previous.at.getTime()) / 1000 : 0,
    );
    const detail = derived.detail;

    if (detail) {
      if (derived.cache_hit_pct != null) {
        samples.push({
          metric_key: "db.cache_hit_pct",
          source,
          value_num: derived.cache_hit_pct,
          meta: {
            blks_hit: detail.blks_hit,
            blks_read: detail.blks_read,
            interval_s: detail.interval_s,
          },
        });
      }
      if (derived.rollback_pct != null) {
        samples.push({
          metric_key: "db.rollback_pct",
          source,
          value_num: derived.rollback_pct,
          meta: {
            commits: detail.commits,
            rollbacks: detail.rollbacks,
            interval_s: detail.interval_s,
          },
        });
      }
      samples.push({
        metric_key: "db.deadlocks",
        source,
        value_num: derived.deadlocks,
        meta: { interval_s: detail.interval_s, lifetime: counters.deadlocks },
      });
      samples.push({
        metric_key: "db.reads_per_s",
        source,
        value_num: derived.reads_per_s,
        meta: { rows: detail.read_rows, interval_s: detail.interval_s },
      });
      samples.push({
        metric_key: "db.writes_per_s",
        source,
        value_num: derived.writes_per_s,
        meta: { rows: detail.write_rows, interval_s: detail.interval_s },
      });
    }
  }

  // ---- dead tuples --------------------------------------------------------
  // Both the absolute count and the share of all tuples. The count alone does
  // not scale: 500k dead rows is a crisis on a 1M-row table and noise on a
  // 100M-row one, and a fixed threshold cannot tell those apart.
  const [dead] = await rows(
    client,
    sql`
      SELECT COALESCE(SUM(n_dead_tup), 0) AS dead,
             COALESCE(SUM(n_live_tup), 0) AS live
      FROM pg_stat_user_tables
    `,
  );
  const deadTuples = num(dead?.dead);
  const liveTuples = num(dead?.live);
  if (deadTuples != null) {
    samples.push({
      metric_key: "db.dead_tuples",
      source,
      value_num: deadTuples,
    });
    const total = deadTuples + (liveTuples ?? 0);
    if (total > 0) {
      samples.push({
        metric_key: "db.dead_tuple_pct",
        source,
        value_num: Math.round((deadTuples / total) * 1000) / 10,
        meta: { dead: deadTuples, live: liveTuples },
      });
    }
  }

  return samples;
}

/**
 * Per-table size and row estimate, for the top 20 by each.
 *
 * The union of both top-20s, not the top 20 by size alone: the biggest table on
 * disk and the one with the most rows are usually different tables, and each
 * answers a different question during an incident.
 *
 * n_live_tup is an ESTIMATE maintained by the stats collector, not a count(*).
 * Counting 40+ tables for real, on a schedule, against the instance we are
 * trying to keep connections free on, would be its own outage.
 */
async function probeTables(
  client: Executor,
  prefix: string,
): Promise<CollectedSample[]> {
  const result = await rows(
    client,
    sql`
      WITH t AS (
        SELECT relname,
               pg_total_relation_size(relid) AS bytes,
               n_live_tup                    AS live
        FROM pg_stat_user_tables
      ),
      by_size AS (SELECT * FROM t ORDER BY bytes DESC LIMIT 20),
      by_rows AS (SELECT * FROM t ORDER BY live  DESC LIMIT 20)
      SELECT * FROM by_size
      UNION
      SELECT * FROM by_rows
    `,
  );

  const samples: CollectedSample[] = [];
  for (const r of result) {
    const table = String(r.relname);
    // source is varchar(80); a table name longer than that would be rejected
    // at write time and take the whole INSERT chunk with it.
    const source = `${prefix}:${table}`.slice(0, 80);
    const bytes = num(r.bytes);
    const live = num(r.live);
    if (bytes != null) {
      samples.push({ metric_key: "db.table_bytes", source, value_num: bytes });
    }
    if (live != null) {
      samples.push({ metric_key: "db.table_rows", source, value_num: live });
    }
  }
  return samples;
}

export const databaseCollector: OpsCollector = {
  id: "db.rds",
  label: "Database health (RDS + IoT)",
  intervalMs: 2 * MINUTE,
  // Several round trips against two databases, one of which is a VPS across
  // the internet. The default 10s is not enough headroom for that.
  timeoutMs: 25_000,

  async run(): Promise<CollectedSample[]> {
    const samples: CollectedSample[] = [];

    // ---- CRM RDS: the one that must always be probed ----------------------
    // Each half is isolated. probeTables runs pg_total_relation_size over every
    // user table and is by far the most expensive thing here; letting it take
    // the connection samples down with it would lose exactly the number this
    // file's header calls the highest-value monitor in the build, at exactly
    // the moment the instance is unhealthy enough to make it time out.
    try {
      samples.push(...(await probeDatabase(db, "rds:crm")));
    } catch (e) {
      samples.push({
        metric_key: "db.connections_used",
        source: "rds:crm",
        value_num: null,
        value_text: `probe failed: ${rootCauseMessage(e)}`,
      });
    }

    try {
      samples.push(...(await probeTables(db, "table")));
    } catch (e) {
      samples.push({
        metric_key: "db.table_bytes",
        source: "table:(probe failed)",
        value_num: null,
        value_text: `probe failed: ${rootCauseMessage(e)}`,
      });
    }

    try {
      const drift = await migrationDrift();
      samples.push({
        metric_key: "db.migration_drift",
        source: "rds:crm",
        value_num: drift.count,
        value_text: drift.missing.slice(0, 20).join(", ") || null,
        meta: { missing: drift.missing },
      });
    } catch (e) {
      // Drift is a nice-to-have; connection headroom is not. Never let a failed
      // information_schema read cost us the numbers above.
      samples.push({
        metric_key: "db.migration_drift",
        source: "rds:crm",
        value_num: null,
        value_text: `unavailable: ${rootCauseMessage(e)}`,
      });
    }

    // ---- IoT bridge: best effort ------------------------------------------
    // Not every environment has IOT_DATABASE_URL, and the VPS is reachable over
    // the public internet. Skipped silently when unconfigured (that is a
    // deployment fact, not a fault); a genuine failure is recorded as a text
    // sample so /operations/database can say "unreachable" rather than showing
    // an empty column that reads as "fine".
    if (process.env.IOT_DATABASE_URL) {
      try {
        const { getIotDb } = await import("@/lib/db/iot");
        samples.push(...(await probeDatabase(getIotDb(), "rds:iot")));
      } catch (e) {
        samples.push({
          metric_key: "db.connections_used",
          source: "rds:iot",
          value_num: null,
          value_text: `unreachable: ${rootCauseMessage(e)}`,
        });
      }
    }

    return samples;
  },
};
