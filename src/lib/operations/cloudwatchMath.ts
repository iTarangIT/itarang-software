/**
 * The pure half of the RDS instance collector.
 *
 * No AWS import, no database import — so the two rules that actually matter
 * here can be tested without credentials, without an RDS instance and without
 * waiting five minutes between readings. Same split as databaseMath.ts.
 *
 * WHY THIS EXISTS AT ALL. Two things about CloudWatch are easy to get wrong and
 * silent when you do:
 *
 *  1. THE STATISTIC IS PART OF THE QUESTION. DiskQueueDepth averaged over a
 *     minute is near zero on an instance that spent two seconds of that minute
 *     with a queue of 40 — the average answers "was it usually busy", which is
 *     not what anyone asks a queue-depth chart. FreeStorageSpace has the mirror
 *     problem: the Average hides the trough that actually filled the volume. So
 *     DiskQueueDepth is Maximum and FreeStorageSpace is Minimum, and those two
 *     are pinned by a test because swapping in Average produces a plausible
 *     number that is quietly answering a different question.
 *
 *  2. CLOUDWATCH IS 2-3 MINUTES BEHIND. A request for "the last 60 seconds"
 *     routinely comes back all-null, and the newest bucket in any window is
 *     usually empty. latestDatapoint() therefore walks for the most recent
 *     NON-NULL reading and returns that datapoint's OWN timestamp, which the
 *     collector writes into CollectedSample.captured_at. Without it the tile
 *     would claim a freshness it does not have — and the page's 15-minute stale
 *     line, which exists to catch exactly that, would never fire.
 */

/** Which statistic answers the question this metric is on the page to answer. */
export type RdsStatistic = "Average" | "Maximum" | "Minimum" | "Sum";

export interface RdsMetricSpec {
  /** CloudWatch's name in the AWS/RDS namespace. */
  metricName: string;
  /** The MetricDef.key in ../registry.ts this lands on. */
  key: string;
  stat: RdsStatistic;
}

/**
 * The metrics collected, and why each earned a place.
 *
 * The list is short ON PURPOSE. A metric that appears in the RDS console is not
 * thereby worth a card: it has to be applicable to THIS instance, meaningful for
 * database health, and not already answered — better — by Postgres itself.
 *
 * The first four are UNIVERSAL: every RDS instance publishes them whatever its
 * class, engine or Performance Insights setting, and each measures something no
 * pg_stat_* view can reach.
 *
 * The last two are CONDITIONAL: CPU credits exist only on T-class burstable
 * instances. They are requested blind rather than gated on an instance-class
 * lookup, because the read model builds tiles from the samples that ACTUALLY
 * ARRIVE — on a non-burstable instance CloudWatch returns nothing, no sample is
 * written, and no tile ever appears. That costs one null datapoint per cycle and
 * removes an entire class of configuration that could drift out of date.
 *
 * They are worth that: on a burstable instance, credit exhaustion is the most
 * likely cause of an unexplained slowdown AND is completely invisible from
 * inside the database. The hypervisor throttles to the ~10% baseline while
 * CPUUtilization still reads as moderate and every Postgres tile looks healthy.
 *
 * DELIBERATELY ABSENT, because Postgres already answers them better:
 *   DatabaseConnections        → db.connections_pct, from pg_stat_activity,
 *                                which excludes background workers, nets the
 *                                superuser-reserved slots off the denominator,
 *                                and carries per-application attribution
 *                                CloudWatch cannot provide.
 *   MaximumUsedTransactionIDs  → db.max_used_txids, from pg_database.
 * A second copy of either would put two tiles on one card disagreeing by a
 * collection interval.
 *
 * DELIBERATELY ABSENT, because they are not database health:
 *   NetworkReceiveThroughput   → redundant with db.txns_per_s, db.queries_per_s
 *                                and the row rates, which measure the same load
 *                                from the Postgres side and more precisely.
 *   CPUSurplusCredit*          → only non-zero AFTER the balance hit zero, and
 *                                CPUSurplusCreditsCharged is a billing figure
 *                                that belongs on the Spend module.
 *   CheckpointLag              → an Aurora PostgreSQL metric. This is RDS for
 *                                PostgreSQL and does not publish it; rendering
 *                                a replication metric for a non-replicated
 *                                instance would mislead.
 */
export const RDS_METRIC_SPECS: RdsMetricSpec[] = [
  { metricName: "CPUUtilization", key: "rds.cpu_pct", stat: "Average" },
  {
    metricName: "FreeableMemory",
    key: "rds.freeable_memory_bytes",
    stat: "Average",
  },
  // Minimum, not Average: the trough is what fills a volume.
  { metricName: "FreeStorageSpace", key: "rds.free_storage_bytes", stat: "Minimum" },
  // Maximum, not Average: a queue that spiked to 40 for two seconds averages to
  // roughly nothing across a 60-second bucket.
  { metricName: "DiskQueueDepth", key: "rds.disk_queue_depth", stat: "Maximum" },
  // T-class only. Silently absent elsewhere — see the note above.
  { metricName: "CPUCreditBalance", key: "rds.cpu_credit_balance", stat: "Average" },
  { metricName: "CPUCreditUsage", key: "rds.cpu_credit_usage", stat: "Average" },
];

/**
 * CloudWatch's per-query id: `m0`, `m1`, … It must match /^[a-z][a-zA-Z0-9_]*$/,
 * so it cannot be the metric key — `rds.cpu_pct` has a dot in it.
 */
export const queryId = (index: number): string => `m${index}`;

/** The MetricDataQuery array for GetMetricData, one entry per spec. */
export function buildMetricQueries(
  instanceId: string,
  periodSeconds = 60,
): Array<{
  Id: string;
  MetricStat: {
    Metric: {
      Namespace: string;
      MetricName: string;
      Dimensions: Array<{ Name: string; Value: string }>;
    };
    Period: number;
    Stat: RdsStatistic;
  };
}> {
  return RDS_METRIC_SPECS.map((spec, i) => ({
    Id: queryId(i),
    MetricStat: {
      Metric: {
        Namespace: "AWS/RDS",
        MetricName: spec.metricName,
        Dimensions: [{ Name: "DBInstanceIdentifier", Value: instanceId }],
      },
      Period: periodSeconds,
      Stat: spec.stat,
    },
  }));
}

export interface Datapoint {
  value: number;
  at: Date;
}

/**
 * The most recent usable reading in one GetMetricData result.
 *
 * Returns null — never 0 — when there is nothing to report. A zero here would
 * render as a real measurement: 0 bytes of FreeStorageSpace reads as a full
 * volume, and 0% CPU as an idle instance. Both are the most alarming or most
 * reassuring possible lie about a number we simply do not have. Same rule as
 * databaseMath.ts.
 *
 * Does NOT assume CloudWatch's ordering. It returns TimestampDescending by
 * default, but that is a request parameter rather than a guarantee, and the
 * cost of scanning ~10 entries is nothing next to silently reporting the oldest
 * bucket in the window as current.
 */
export function latestDatapoint(
  timestamps: Array<Date | string | undefined | null> | undefined,
  values: Array<number | undefined | null> | undefined,
): Datapoint | null {
  if (!timestamps || !values) return null;

  let best: Datapoint | null = null;
  // Pairs are positional: values[i] belongs to timestamps[i]. A response where
  // the two arrays disagree in length is malformed, so only the overlap is read
  // rather than trusting one length for both.
  const n = Math.min(timestamps.length, values.length);

  for (let i = 0; i < n; i++) {
    const value = values[i];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;

    const raw = timestamps[i];
    if (raw == null) continue;
    const at = raw instanceof Date ? raw : new Date(raw);
    if (Number.isNaN(at.getTime())) continue;

    if (!best || at.getTime() > best.at.getTime()) best = { value, at };
  }

  return best;
}

/**
 * How far back to ask.
 *
 * Ten minutes against a 5-minute collection interval, so a single missed cycle
 * still finds a datapoint and the tile does not blank for a transient. The
 * 2-3 minute publication lag means a window shorter than about five minutes
 * comes back entirely null on a healthy instance.
 */
export const LOOKBACK_MINUTES = 10;

/** The [start, end] window for one collection, given "now". */
export function lookbackWindow(now: Date): { start: Date; end: Date } {
  return {
    start: new Date(now.getTime() - LOOKBACK_MINUTES * 60_000),
    end: now,
  };
}
