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
import { rootCauseMessage } from "@/lib/operations/errors";

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

/** Connections, query ages, cache/transaction stats and size for one database. */
async function probeDatabase(
  client: Executor,
  source: string,
): Promise<CollectedSample[]> {
  const samples: CollectedSample[] = [];

  // ---- connections -------------------------------------------------------
  // current_setting() rather than SHOW: SHOW cannot be used as a subquery, and
  // this needs both numbers in one round trip to be consistent with each other.
  //
  // A non-superuser sees every ROW of pg_stat_activity (so the count is right)
  // but has query/state masked for other roles' backends — which is why the
  // ages below are best-effort on the IoT bridge and exact on the CRM.
  const [conn] = await rows(
    client,
    sql`
      SELECT
        (SELECT COUNT(*) FROM pg_stat_activity)      AS used,
        current_setting('max_connections')::int      AS max_conn
    `,
  );
  const used = num(conn?.used);
  const maxConn = num(conn?.max_conn);
  if (used != null) {
    samples.push({ metric_key: "db.connections_used", source, value_num: used });
  }
  if (maxConn != null) {
    samples.push({
      metric_key: "db.max_connections",
      source,
      value_num: maxConn,
    });
    if (used != null && maxConn > 0) {
      samples.push({
        metric_key: "db.connections_pct",
        source,
        value_num: Math.round((used / maxConn) * 1000) / 10,
      });
    }
  }

  // ---- query / transaction ages ------------------------------------------
  // Excludes this backend: the collector's own query is always the newest
  // "active" one, and counting it would put a floor under longest_query_s.
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

  // ---- cache, transactions, deadlocks, size -------------------------------
  // Cumulative since the last stats reset, which is what the thresholds in
  // registry.ts assume: it is the movement between samples that means something,
  // not the absolute number.
  const [stat] = await rows(
    client,
    sql`
      SELECT
        blks_hit, blks_read, xact_commit, xact_rollback, deadlocks,
        pg_database_size(current_database()) AS size_bytes
      FROM pg_stat_database
      WHERE datname = current_database()
    `,
  );
  if (stat) {
    const hit = num(stat.blks_hit) ?? 0;
    const read = num(stat.blks_read) ?? 0;
    if (hit + read > 0) {
      samples.push({
        metric_key: "db.cache_hit_pct",
        source,
        value_num: Math.round((hit / (hit + read)) * 1000) / 10,
      });
    }

    const commit = num(stat.xact_commit) ?? 0;
    const rollback = num(stat.xact_rollback) ?? 0;
    if (commit + rollback > 0) {
      samples.push({
        metric_key: "db.rollback_pct",
        source,
        value_num: Math.round((rollback / (commit + rollback)) * 1000) / 10,
      });
    }

    const deadlocks = num(stat.deadlocks);
    if (deadlocks != null) {
      samples.push({ metric_key: "db.deadlocks", source, value_num: deadlocks });
    }

    const size = num(stat.size_bytes);
    if (size != null) {
      samples.push({ metric_key: "db.size_bytes", source, value_num: size });
    }
  }

  // ---- dead tuples --------------------------------------------------------
  const [dead] = await rows(
    client,
    sql`SELECT COALESCE(SUM(n_dead_tup), 0) AS dead FROM pg_stat_user_tables`,
  );
  const deadTuples = num(dead?.dead);
  if (deadTuples != null) {
    samples.push({
      metric_key: "db.dead_tuples",
      source,
      value_num: deadTuples,
    });
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
    samples.push(...(await probeDatabase(db, "rds:crm")));
    samples.push(...(await probeTables(db, "table")));

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
