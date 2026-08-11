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
}

export interface IntervalMetrics {
  cache_hit_pct: number | null;
  rollback_pct: number | null;
  deadlocks: number | null;
  reads_per_s: number | null;
  writes_per_s: number | null;
  /** Deltas and span, for the samples' meta. */
  detail: {
    interval_s: number;
    blks_hit: number;
    blks_read: number;
    commits: number;
    rollbacks: number;
    read_rows: number;
    write_rows: number;
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

  return {
    // No block accesses at all in the interval means there is no ratio to
    // report. Reporting 0% would read as a total cache collapse on an idle
    // database.
    cache_hit_pct: blocks > 0 ? round1((d.blks_hit / blocks) * 100) : null,
    rollback_pct: xacts > 0 ? round1((d.xact_rollback / xacts) * 100) : null,
    deadlocks: d.deadlocks,
    reads_per_s: round1(d.reads / elapsedSeconds),
    writes_per_s: round1(d.writes / elapsedSeconds),
    detail: {
      interval_s: Math.round(elapsedSeconds),
      blks_hit: d.blks_hit,
      blks_read: d.blks_read,
      commits: d.xact_commit,
      rollbacks: d.xact_rollback,
      read_rows: d.reads,
      write_rows: d.writes,
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
