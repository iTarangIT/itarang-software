import { describe, expect, it } from "vitest";

import {
  buildMetricQueries,
  latestDatapoint,
  lookbackWindow,
  queryId,
  RDS_METRIC_SPECS,
} from "../cloudwatchMath";
import { getMetric } from "../registry";

/**
 * What this file pins.
 *
 * Two classes of bug, both of which produce a number that LOOKS right:
 *
 *  1. The wrong statistic. DiskQueueDepth as an Average and FreeStorageSpace as
 *     an Average both return plausible values that answer a different question
 *     than the tile is asking. Nothing downstream can detect it.
 *  2. A zero standing in for a missing reading. CloudWatch buckets are commonly
 *     null for the most recent 2-3 minutes; defaulting those to 0 would render
 *     as a full disk or an idle CPU rather than as "no data".
 */

/** A GetMetricData result for one query, newest first as CloudWatch returns it. */
function result(pairs: Array<[string, number | null]>): {
  timestamps: Date[];
  values: Array<number | null>;
} {
  return {
    timestamps: pairs.map(([t]) => new Date(t)),
    values: pairs.map(([, v]) => v),
  };
}

describe("RDS_METRIC_SPECS", () => {
  it("asks for the Maximum disk queue depth, not the average", () => {
    // A queue that sat at 40 for two seconds of a 60-second bucket averages to
    // roughly nothing. The average answers "was it usually busy", which is not
    // the question a queue-depth tile exists to answer.
    const spec = RDS_METRIC_SPECS.find((s) => s.metricName === "DiskQueueDepth");
    expect(spec?.stat).toBe("Maximum");
  });

  it("asks for the Minimum free storage, not the average", () => {
    // The trough is what fills a volume; the mean hides it.
    const spec = RDS_METRIC_SPECS.find(
      (s) => s.metricName === "FreeStorageSpace",
    );
    expect(spec?.stat).toBe("Minimum");
  });

  it("declares every metric key in the registry", () => {
    // views.ts reading() returns null for an unregistered key, so a typo here
    // would not throw — the tile would simply never appear, on a page nobody
    // looks at until something is broken.
    for (const spec of RDS_METRIC_SPECS) {
      expect(
        getMetric(spec.key),
        `${spec.key} missing from registry`,
      ).toBeDefined();
    }
  });

  it("does not duplicate a metric Postgres already answers better", () => {
    // db.connections_pct excludes background workers and carries
    // per-application attribution; db.max_used_txids is the same measurement
    // read from pg_database. A CloudWatch copy of either would disagree with
    // the tile beside it by one collection interval.
    const names = RDS_METRIC_SPECS.map((s) => s.metricName);
    expect(names).not.toContain("DatabaseConnections");
    expect(names).not.toContain("MaximumUsedTransactionIDs");
  });

  it("excludes the metrics that are not database health", () => {
    // Each of these is available from CloudWatch and was deliberately rejected:
    //   NetworkReceiveThroughput  — redundant with the Postgres throughput
    //                               tiles, which measure the same load more
    //                               precisely.
    //   CPUSurplusCredit*         — only non-zero after the balance already hit
    //                               zero; CreditsCharged is a billing figure.
    //   CheckpointLag             — Aurora-only. Rendering a replication metric
    //                               for a non-replicated RDS instance misleads.
    // Pinned so a future "let's add the rest of the screenshot" cannot land
    // without someone deleting a test that says why not.
    const names = RDS_METRIC_SPECS.map((s) => s.metricName);
    for (const rejected of [
      "NetworkReceiveThroughput",
      "CPUSurplusCreditBalance",
      "CPUSurplusCreditsCharged",
      "CheckpointLag",
    ]) {
      expect(names, `${rejected} was deliberately excluded`).not.toContain(
        rejected,
      );
    }
  });

  it("requests the T-class credit metrics blind, without an instance-class gate", () => {
    // They are asked for on every instance. On a non-burstable class CloudWatch
    // returns nothing, no sample is written, and the read model — which builds
    // tiles from samples that arrived — never renders a tile. That is what lets
    // this file carry no instance-class configuration at all.
    const names = RDS_METRIC_SPECS.map((s) => s.metricName);
    expect(names).toContain("CPUCreditBalance");
    expect(names).toContain("CPUCreditUsage");
  });

  it("keeps every metric on the AWS/RDS instance dimension", () => {
    // Nothing here is a Performance Insights metric: DBLoad and its variants
    // are only published when PI is enabled on the instance, which is a
    // configuration change this collector must not silently depend on.
    const names = RDS_METRIC_SPECS.map((s) => s.metricName);
    for (const pi of ["DBLoad", "DBLoadCPU", "DBLoadNonCPU"]) {
      expect(names).not.toContain(pi);
    }
  });

  it("uses unique keys and unique CloudWatch metric names", () => {
    expect(new Set(RDS_METRIC_SPECS.map((s) => s.key)).size).toBe(
      RDS_METRIC_SPECS.length,
    );
    expect(new Set(RDS_METRIC_SPECS.map((s) => s.metricName)).size).toBe(
      RDS_METRIC_SPECS.length,
    );
  });
});

describe("buildMetricQueries", () => {
  const queries = buildMetricQueries("database-2");

  it("emits one query per spec, in the AWS/RDS namespace", () => {
    expect(queries).toHaveLength(RDS_METRIC_SPECS.length);
    for (const q of queries) {
      expect(q.MetricStat.Metric.Namespace).toBe("AWS/RDS");
    }
  });

  it("dimensions every query by DBInstanceIdentifier", () => {
    // Without the dimension CloudWatch returns the namespace-wide aggregate
    // across every RDS instance in the account — a real number, for the wrong
    // database, with nothing on screen to reveal it.
    for (const q of queries) {
      expect(q.MetricStat.Metric.Dimensions).toEqual([
        { Name: "DBInstanceIdentifier", Value: "database-2" },
      ]);
    }
  });

  it("gives each query an id CloudWatch will accept", () => {
    // Ids must match /^[a-z][a-zA-Z0-9_]*$/, so the metric key cannot be used:
    // "rds.cpu_pct" has a dot and would be rejected at request time.
    for (const q of queries) expect(q.Id).toMatch(/^[a-z][a-zA-Z0-9_]*$/);
    expect(new Set(queries.map((q) => q.Id)).size).toBe(queries.length);
    expect(queryId(0)).toBe("m0");
  });

  it("requests the 60-second period RDS actually publishes at", () => {
    for (const q of queries) expect(q.MetricStat.Period).toBe(60);
  });

  it("carries each spec's statistic and name through unchanged", () => {
    for (const [i, spec] of RDS_METRIC_SPECS.entries()) {
      expect(queries[i].MetricStat.Stat).toBe(spec.stat);
      expect(queries[i].MetricStat.Metric.MetricName).toBe(spec.metricName);
    }
  });
});

describe("latestDatapoint", () => {
  it("returns the newest reading", () => {
    const r = result([
      ["2026-08-26T10:05:00Z", 42],
      ["2026-08-26T10:04:00Z", 41],
    ]);
    expect(latestDatapoint(r.timestamps, r.values)).toEqual({
      value: 42,
      at: new Date("2026-08-26T10:05:00Z"),
    });
  });

  it("skips the trailing nulls CloudWatch's publication lag leaves behind", () => {
    // The most recent two buckets are routinely empty. Taking index 0 blindly
    // would report "no data" on a perfectly healthy instance every cycle.
    const r = result([
      ["2026-08-26T10:06:00Z", null],
      ["2026-08-26T10:05:00Z", null],
      ["2026-08-26T10:04:00Z", 37],
      ["2026-08-26T10:03:00Z", 36],
    ]);
    expect(latestDatapoint(r.timestamps, r.values)).toEqual({
      value: 37,
      at: new Date("2026-08-26T10:04:00Z"),
    });
  });

  it("returns the datapoint's own timestamp so captured_at can be back-dated", () => {
    // Stamping these with now() would claim a freshness the reading does not
    // have, and the page's 15-minute stale line would never fire.
    const r = result([["2026-08-26T09:58:00Z", 12]]);
    expect(latestDatapoint(r.timestamps, r.values)?.at.toISOString()).toBe(
      "2026-08-26T09:58:00.000Z",
    );
  });

  it("does not assume CloudWatch sorted the response", () => {
    // TimestampDescending is a request parameter, not a guarantee.
    const r = result([
      ["2026-08-26T10:01:00Z", 1],
      ["2026-08-26T10:09:00Z", 9],
      ["2026-08-26T10:04:00Z", 4],
    ]);
    expect(latestDatapoint(r.timestamps, r.values)?.value).toBe(9);
  });

  it("returns null, never zero, for an all-null series", () => {
    // 0 bytes of FreeStorageSpace reads as a full volume; 0% CPU as an idle
    // instance. Both are lies about a number we do not have.
    const r = result([
      ["2026-08-26T10:05:00Z", null],
      ["2026-08-26T10:04:00Z", null],
    ]);
    expect(latestDatapoint(r.timestamps, r.values)).toBeNull();
  });

  it("returns null for an empty, absent or malformed response", () => {
    expect(latestDatapoint([], [])).toBeNull();
    expect(latestDatapoint(undefined, undefined)).toBeNull();
    expect(latestDatapoint(undefined, [1])).toBeNull();
    expect(latestDatapoint([new Date()], undefined)).toBeNull();
  });

  it("keeps a real zero when CloudWatch actually reported one", () => {
    // The rule is "null is not zero", not "zero is not a reading". A genuinely
    // idle instance reporting a queue depth of 0 must still render as 0.
    const r = result([["2026-08-26T10:05:00Z", 0]]);
    expect(latestDatapoint(r.timestamps, r.values)?.value).toBe(0);
  });

  it("ignores NaN and Infinity", () => {
    const ts = [
      new Date("2026-08-26T10:05:00Z"),
      new Date("2026-08-26T10:04:00Z"),
    ];
    expect(latestDatapoint(ts, [Number.NaN, 5])?.value).toBe(5);
    expect(latestDatapoint(ts, [Number.POSITIVE_INFINITY, 5])?.value).toBe(5);
  });

  it("reads only the overlap when the two arrays disagree in length", () => {
    const ts = [new Date("2026-08-26T10:05:00Z")];
    expect(latestDatapoint(ts, [1, 2, 3])?.value).toBe(1);
  });

  it("accepts ISO strings as well as Dates", () => {
    expect(latestDatapoint(["2026-08-26T10:05:00Z"], [7])?.value).toBe(7);
    expect(latestDatapoint(["not a date"], [7])).toBeNull();
  });
});

describe("lookbackWindow", () => {
  it("asks for ten minutes, so one missed cycle does not blank the tile", () => {
    // A window shorter than ~5 minutes comes back entirely null on a healthy
    // instance, because CloudWatch publishes 2-3 minutes behind.
    const now = new Date("2026-08-26T10:00:00Z");
    const { start, end } = lookbackWindow(now);
    expect(end).toEqual(now);
    expect(start).toEqual(new Date("2026-08-26T09:50:00Z"));
  });
});
