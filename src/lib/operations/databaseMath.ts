/**
 * The interval arithmetic behind /operations/database.
 *
 * Pure — no database import — so the rules below can be tested without an RDS
 * instance and two minutes of waiting. Same split as elevenlabsSeries.ts and
 * logsMath.ts.
 *
 * WHY THIS EXISTS AT ALL. Every counter in pg_stat_database is cumulative since
 * the last stats reset, and this instance has never had one: blks_hit is
 * 995,334,660 against blks_read 13,042, so the LIFETIME cache hit ratio is
 * 100.00% and no cache collapse today could drag it below the 97% warn line.
 * The rollback ratio was frozen near 0.08% for the same reason, and `deadlocks`
 * as a running total meant the tile latched red on the first deadlock the
 * database ever had and could never clear.
 *
 * So the level is not the metric — the movement between two readings is.
 */

export interface StatCounters {
  blks_hit: number;
  blks_read: number;
  xact_commit: number;
  xact_rollback: number;
  deadlocks: number;
  /** tup_returned + tup_fetched. */
  reads: number;
  /** tup_inserted + tup_updated + tup_deleted. */
  writes: number;
  /**
   * SUM(calls) from pg_stat_statements — statements executed, server-wide.
   *
   * OPTIONAL ON PURPOSE, and deliberately not one of the required fields above.
   * Three separate reasons, each of which would otherwise be a silent
   * regression:
   *
   *  1. pg_stat_statements is an extension. It is present on the CRM RDS but
   *     cannot be assumed on the IoT database, whose role is SELECT-only.
   *  2. Every db.stat_counters sample already written predates this field. If
   *     it were required, `previousCounters()` would reject all of them and the
   *     four working interval metrics would blank for MAX_COUNTER_AGE_MINUTES
   *     after every deploy that ships this change.
   *  3. It resets on its own schedule (pg_stat_statements_reset), independently
   *     of pg_stat_database. Folding it into the shared negative-delta guard
   *     would let one extension's reset discard the cache-hit ratio too.
   *
   * So it is carried alongside, differenced separately, and its absence costs
   * exactly one metric.
   */
  calls?: number | null;
}

export interface IntervalMetrics {
  cache_hit_pct: number | null;
  rollback_pct: number | null;
  deadlocks: number | null;
  reads_per_s: number | null;
  writes_per_s: number | null;
  /**
   * Transactions per second — Δ(xact_commit + xact_rollback) / Δt.
   *
   * The request-rate metric that needs no extension, so it is the one the board
   * can always show. Counts transactions, not statements: an autocommit query
   * is one of each, but a multi-statement transaction is one txn and many
   * statements, which is why queries_per_s sits beside it rather than replacing
   * it.
   */
  txns_per_s: number | null;
  /**
   * Statements per second — Δ SUM(pg_stat_statements.calls) / Δt.
   *
   * Null, never zero, whenever either reading lacks `calls` or the extension
   * reset between them.
   */
  queries_per_s: number | null;
  /** Deltas and span, for the samples' meta. */
  detail: {
    interval_s: number;
    blks_hit: number;
    blks_read: number;
    commits: number;
    rollbacks: number;
    read_rows: number;
    write_rows: number;
    /** Statements in the interval; absent when pg_stat_statements is not usable. */
    queries?: number;
  } | null;
  /**
   * Why nothing was derived, when nothing was. Surfaced so a blank tile can be
   * explained rather than guessed at.
   */
  skipped: "no-predecessor" | "counters-reset" | "zero-elapsed" | null;
}

const NOTHING: IntervalMetrics = {
  cache_hit_pct: null,
  rollback_pct: null,
  deadlocks: null,
  reads_per_s: null,
  writes_per_s: null,
  txns_per_s: null,
  queries_per_s: null,
  detail: null,
  skipped: "no-predecessor",
};

/** One decimal place, the precision every percentage tile renders at. */
const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Derive the interval metrics from two readings of the same counters.
 *
 * Returns nulls — never zeros — whenever the interval cannot be described. A
 * zero renders as a real measurement of a healthy database and hides the fact
 * that we do not know, which is the same rule ops-agent follows for a missing
 * host reading.
 */
export function intervalMetrics(
  previous: StatCounters | null,
  current: StatCounters,
  elapsedSeconds: number,
): IntervalMetrics {
  // First run after a deploy, or a gap longer than the caller's window.
  if (!previous) return NOTHING;

  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
    return { ...NOTHING, skipped: "zero-elapsed" };
  }

  const d = {
    blks_hit: current.blks_hit - previous.blks_hit,
    blks_read: current.blks_read - previous.blks_read,
    xact_commit: current.xact_commit - previous.xact_commit,
    xact_rollback: current.xact_rollback - previous.xact_rollback,
    deadlocks: current.deadlocks - previous.deadlocks,
    reads: current.reads - previous.reads,
    writes: current.writes - previous.writes,
  };

  // Counters that went BACKWARDS mean a stats reset or a failover onto a
  // different instance. The interval spanning that reset describes nothing —
  // and taken at face value would produce a huge negative rate — so it is
  // skipped entirely. The next interval is clean.
  if (Object.values(d).some((v) => v < 0)) {
    return { ...NOTHING, skipped: "counters-reset" };
  }

  const blocks = d.blks_hit + d.blks_read;
  const xacts = d.xact_commit + d.xact_rollback;

  // Statements are differenced on their own, outside `d` and outside the guard
  // above. Both readings must carry a finite `calls`, and the extension must
  // not have been reset between them; failing either yields null, so the tile
  // reads "unknown" rather than claiming an idle database.
  const queryDelta =
    typeof previous.calls === "number" &&
    Number.isFinite(previous.calls) &&
    typeof current.calls === "number" &&
    Number.isFinite(current.calls) &&
    current.calls >= previous.calls
      ? current.calls - previous.calls
      : null;

  return {
    // No block accesses at all in the interval means there is no ratio to
    // report. Reporting 0% would read as a total cache collapse on an idle
    // database.
    cache_hit_pct: blocks > 0 ? round1((d.blks_hit / blocks) * 100) : null,
    rollback_pct: xacts > 0 ? round1((d.xact_rollback / xacts) * 100) : null,
    deadlocks: d.deadlocks,
    reads_per_s: round1(d.reads / elapsedSeconds),
    writes_per_s: round1(d.writes / elapsedSeconds),
    txns_per_s: round1(xacts / elapsedSeconds),
    queries_per_s:
      queryDelta == null ? null : round1(queryDelta / elapsedSeconds),
    detail: {
      interval_s: Math.round(elapsedSeconds),
      blks_hit: d.blks_hit,
      blks_read: d.blks_read,
      commits: d.xact_commit,
      rollbacks: d.xact_rollback,
      read_rows: d.reads,
      write_rows: d.writes,
      ...(queryDelta == null ? {} : { queries: queryDelta }),
    },
    skipped: null,
  };
}

/**
 * Connection capacity as a percentage of the slots the APPLICATION can reach.
 *
 * `max_connections` counts the superuser-reserved slots, which the app can
 * never have, so using it as the denominator overstates headroom by exactly the
 * amount that matters during the incident this metric exists to predict.
 *
 * Returns null rather than a number when the denominator is unusable — a
 * percentage of nothing is not 0%.
 */
export function connectionCapacityPct(
  used: number | null,
  maxConnections: number | null,
  superuserReserved: number,
): number | null {
  if (used == null || maxConnections == null) return null;
  const usable = maxConnections - superuserReserved;
  if (!Number.isFinite(usable) || usable <= 0) return null;
  return round1((used / usable) * 100);
}

/**
 * The transaction-ID budget: 2^31.
 *
 * Postgres XIDs are 32-bit and compared modulo 2^32, so a transaction can only
 * see 2^31 into the past — that half is the whole usable range, not 2^32. When
 * `age(datfrozenxid)` approaches it the server refuses new writes and the only
 * exit is single-user-mode VACUUM, i.e. planned downtime on an unplanned
 * schedule. Autovacuum normally freezes long before this (RDS ships
 * autovacuum_freeze_max_age at 200M, ~9% of the budget); the number climbing
 * anyway is the signal that autovacuum is losing, which is what makes it worth
 * a tile.
 */
export const TXID_WRAPAROUND_LIMIT = 2 ** 31;

/**
 * How much of the transaction-ID budget is spent, 0-100.
 *
 * A PERCENTAGE RATHER THAN THE RAW COUNT, on purpose. formatCount renders
 * through Intl.NumberFormat("en-IN"), so 1000000000 becomes "1,00,00,00,000" —
 * ten digits and two unfamiliar group breaks in a tile that is one-fifth of a
 * card row. Nobody reads that as "half the budget". The raw count is still
 * collected as db.max_used_txids so the history stays exact; this is the number
 * that gets a threshold.
 *
 * Null, never zero, for a missing or nonsensical reading — the same rule the
 * interval metrics above follow.
 */
export function txidWraparoundPct(maxUsedTxids: number | null): number | null {
  if (maxUsedTxids == null) return null;
  if (!Number.isFinite(maxUsedTxids) || maxUsedTxids < 0) return null;
  return round1((maxUsedTxids / TXID_WRAPAROUND_LIMIT) * 100);
}
