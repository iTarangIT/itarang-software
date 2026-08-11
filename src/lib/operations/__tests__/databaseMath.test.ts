import { describe, expect, it } from "vitest";

import {
  connectionCapacityPct,
  intervalMetrics,
  type StatCounters,
} from "../databaseMath";

/**
 * The two corrections behind /operations/database.
 *
 * 1. Connections were counted from every row of pg_stat_activity, including
 *    background workers that consume no max_connections slot. On the sandbox
 *    instance that reported 15 of 79 (19.0%) where the truth was 9 of 76
 *    (11.8%) — on the single tile the module exists for.
 *
 * 2. Cache hit ratio, rollback ratio and deadlocks were read as LEVELS of
 *    counters that only ever climb. With blks_hit at 995,334,660 against
 *    blks_read 13,042 and stats_reset NULL, the cache tile was pinned at
 *    100.00% forever and could not cross its own 97% warn line.
 */

const counters = (over: Partial<StatCounters> = {}): StatCounters => ({
  blks_hit: 1_000_000,
  blks_read: 10_000,
  xact_commit: 50_000,
  xact_rollback: 100,
  deadlocks: 3,
  reads: 900_000,
  writes: 40_000,
  ...over,
});

describe("intervalMetrics", () => {
  it("measures the INTERVAL, not the lifetime average", () => {
    // Lifetime looks perfect: 1,000,000 hits vs 10,000 reads = 99.0%.
    // But in this interval only half the block accesses were served from cache.
    const previous = counters();
    const current = counters({
      blks_hit: 1_000_000 + 500,
      blks_read: 10_000 + 500,
    });

    const m = intervalMetrics(previous, current, 120);
    expect(m.cache_hit_pct).toBe(50);
    // The lifetime figure would have been ~99 and would never have alerted.
    expect(m.cache_hit_pct).not.toBe(99);
  });

  it("reports deadlocks in the interval, not the running total", () => {
    // Lifetime is 5; the tile used to latch red forever on that. Only ONE
    // happened in this interval.
    const m = intervalMetrics(counters({ deadlocks: 4 }), counters({ deadlocks: 5 }), 120);
    expect(m.deadlocks).toBe(1);
    expect(m.deadlocks).not.toBe(5);
  });

  it("reports a quiet interval as zero deadlocks, so a red tile can clear", () => {
    const m = intervalMetrics(counters({ deadlocks: 9 }), counters({ deadlocks: 9 }), 120);
    expect(m.deadlocks).toBe(0);
  });

  it("computes the rollback ratio over the interval", () => {
    const m = intervalMetrics(
      counters(),
      counters({ xact_commit: 50_000 + 90, xact_rollback: 100 + 10 }),
      120,
    );
    expect(m.rollback_pct).toBe(10);
  });

  it("computes read and write rates per second", () => {
    const m = intervalMetrics(
      counters(),
      counters({ reads: 900_000 + 12_000, writes: 40_000 + 600 }),
      120,
    );
    expect(m.reads_per_s).toBe(100);
    expect(m.writes_per_s).toBe(5);
    expect(m.detail).toMatchObject({ interval_s: 120, read_rows: 12_000, write_rows: 600 });
  });

  it("OMITS everything when there is no predecessor — never zero", () => {
    // First run after a deploy. A zero would render as a real measurement of a
    // perfectly idle, perfectly cache-missing database.
    const m = intervalMetrics(null, counters(), 120);
    expect(m.skipped).toBe("no-predecessor");
    expect(m.cache_hit_pct).toBeNull();
    expect(m.rollback_pct).toBeNull();
    expect(m.deadlocks).toBeNull();
    expect(m.reads_per_s).toBeNull();
    expect(m.writes_per_s).toBeNull();
    expect(m.detail).toBeNull();
  });

  it("skips an interval whose counters went BACKWARDS", () => {
    // A stats reset, or a failover onto a different instance. Taken at face
    // value this would emit a huge negative rate.
    const m = intervalMetrics(counters({ blks_hit: 1_000_000 }), counters({ blks_hit: 5 }), 120);
    expect(m.skipped).toBe("counters-reset");
    expect(m.cache_hit_pct).toBeNull();
    expect(m.reads_per_s).toBeNull();
  });

  it("skips a zero or nonsensical elapsed time rather than dividing by it", () => {
    for (const elapsed of [0, -30, NaN, Infinity]) {
      const m = intervalMetrics(counters(), counters(), elapsed);
      expect(m.skipped).toBe("zero-elapsed");
      expect(m.reads_per_s).toBeNull();
    }
  });

  it("reports NO cache ratio for an interval with no block accesses", () => {
    // An idle database. 0% would read as a total cache collapse.
    const m = intervalMetrics(counters(), counters(), 120);
    expect(m.cache_hit_pct).toBeNull();
    expect(m.rollback_pct).toBeNull();
    // Rates are still real: genuinely zero rows per second.
    expect(m.reads_per_s).toBe(0);
    expect(m.writes_per_s).toBe(0);
    expect(m.deadlocks).toBe(0);
  });

  it("never returns a percentage outside 0-100", () => {
    const m = intervalMetrics(
      counters(),
      counters({ blks_hit: 1_000_000 + 7, blks_read: 10_000 + 3 }),
      60,
    );
    expect(m.cache_hit_pct).toBeGreaterThanOrEqual(0);
    expect(m.cache_hit_pct).toBeLessThanOrEqual(100);
  });
});

describe("connectionCapacityPct", () => {
  it("excludes the superuser-reserved slots the app can never have", () => {
    // The real sandbox reading: 9 client backends, max_connections 79,
    // superuser_reserved_connections 3 → 9/76.
    expect(connectionCapacityPct(9, 79, 3)).toBe(11.8);
  });

  it("differs from the naive max_connections denominator", () => {
    // 9/79 would be 11.4 — and the OLD bug also counted 6 background workers,
    // making it 15/79 = 19.0.
    expect(connectionCapacityPct(9, 79, 3)).not.toBe(11.4);
    expect(connectionCapacityPct(15, 79, 0)).toBe(19);
  });

  it("can exceed 100 so over-capacity is visible rather than clamped", () => {
    expect(connectionCapacityPct(80, 79, 3)).toBeGreaterThan(100);
  });

  it("returns null rather than 0 when the inputs cannot make a percentage", () => {
    expect(connectionCapacityPct(null, 79, 3)).toBeNull();
    expect(connectionCapacityPct(9, null, 3)).toBeNull();
    expect(connectionCapacityPct(9, 3, 3)).toBeNull(); // usable = 0
    expect(connectionCapacityPct(9, 2, 3)).toBeNull(); // usable negative
  });
});
