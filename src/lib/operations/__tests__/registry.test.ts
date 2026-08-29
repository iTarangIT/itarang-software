import { describe, expect, it } from "vitest";

import {
  breaches,
  comparatorFor,
  getMetric,
  METRICS,
  metricsForModule,
  severityFor,
  severityForRule,
  slideMetrics,
  thresholdOrderError,
} from "../registry";

/**
 * The registry is the contract between collectors, pages, thresholds and
 * alerting. A malformed entry here does not fail loudly — it produces a tile
 * that cannot render, or a rule that never fires. These are the invariants that
 * would otherwise only be discovered in production.
 */

describe("registry invariants", () => {
  it("has unique keys", () => {
    const keys = METRICS.map((m) => m.key);
    const duplicates = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(duplicates).toEqual([]);
  });

  it("gives every metric a label, a unit and a module", () => {
    for (const m of METRICS) {
      expect(m.label.trim(), `${m.key} label`).not.toBe("");
      expect(m.unit, `${m.key} unit`).toBeTruthy();
      expect(m.module, `${m.key} module`).toBeTruthy();
    }
  });

  it("uses dot-namespaced keys", () => {
    // The key is written into ops_metric_samples and parsed nowhere, but the
    // convention is what keeps the registry readable at 60+ entries.
    for (const m of METRICS) expect(m.key, m.key).toMatch(/^[a-z][a-z0-9_]*\./);
  });

  it("puts warn on the correct side of crit for the metric's direction", () => {
    // The failure this catches: a lower_is_better metric with warn ABOVE crit
    // can never reach 'warn' — it jumps straight to 'crit' — so the early
    // warning it exists to give is silently unreachable.
    for (const m of METRICS) {
      if (m.warn == null || m.crit == null) continue;
      if (m.direction === "lower_is_better") {
        expect(m.warn, `${m.key}: warn must be <= crit`).toBeLessThanOrEqual(m.crit);
      } else if (m.direction === "higher_is_better") {
        expect(m.warn, `${m.key}: warn must be >= crit`).toBeGreaterThanOrEqual(m.crit);
      }
    }
  });

  it("never puts a threshold on a neutral metric", () => {
    // A neutral metric is tracked but never alerted on, so a threshold would be
    // seeded into ops_alert_rules and then ignored — a rule that looks live and
    // is not.
    for (const m of METRICS) {
      if (m.direction !== "neutral") continue;
      expect(m.warn, `${m.key} warn`).toBeUndefined();
      expect(m.crit, `${m.key} crit`).toBeUndefined();
    }
  });

  it("keeps the one-slide board short enough to fit a screen", () => {
    // The board's entire value is being screenshot-able without scrolling.
    expect(slideMetrics().length).toBeLessThanOrEqual(20);
    expect(slideMetrics().length).toBeGreaterThan(0);
  });

  it("resolves every key through getMetric", () => {
    for (const m of METRICS) expect(getMetric(m.key)?.key).toBe(m.key);
    expect(getMetric("nope.not.a.metric")).toBeUndefined();
  });

  it("assigns every metric to a module that has members", () => {
    for (const m of METRICS) {
      expect(metricsForModule(m.module).length).toBeGreaterThan(0);
    }
  });
});

describe("comparatorFor", () => {
  it("maps direction to the side that breaches", () => {
    expect(comparatorFor({ direction: "lower_is_better" } as never)).toBe("gt");
    expect(comparatorFor({ direction: "higher_is_better" } as never)).toBe("lt");
    expect(comparatorFor({ direction: "neutral" } as never)).toBe("gt");
  });
});

describe("breaches", () => {
  it("uses a strict comparison for magnitudes", () => {
    // "warn above 80%" must not fire at exactly 80.
    expect(breaches("gt", 80, 80, "percent")).toBe(false);
    expect(breaches("gt", 80.1, 80, "percent")).toBe(true);
    expect(breaches("lt", 21, 21, "days")).toBe(false);
    expect(breaches("lt", 20, 21, "days")).toBe(true);
  });

  it("uses an inclusive comparison for booleans on the gt side", () => {
    // REGRESSION: job.last_run_failed and app.redis_circuit_open are
    // lower_is_better with warn = crit = 1, meaning "1 is the broken state".
    // Under a strict `>` this was `1 > 1` — false — so a failing job could
    // never open an alert.
    expect(breaches("gt", 1, 1, "bool")).toBe(true);
    expect(breaches("gt", 0, 1, "bool")).toBe(false);
  });

  it("keeps the lt side strict for booleans", () => {
    // app.dep_ok is higher_is_better with threshold 1. An inclusive `<=` here
    // would fire on a perfectly healthy dependency.
    expect(breaches("lt", 1, 1, "bool")).toBe(false);
    expect(breaches("lt", 0, 1, "bool")).toBe(true);
  });

  it("treats a missing threshold as no breach", () => {
    expect(breaches("gt", 999, null, "count")).toBe(false);
    expect(breaches("gt", 999, undefined, "count")).toBe(false);
    expect(breaches("gt", 999, NaN, "count")).toBe(false);
  });
});

describe("severityFor", () => {
  const disk = getMetric("host.disk_used_pct")!;

  it("escalates through ok, warn and crit", () => {
    expect(severityFor(disk, 50)).toBe("ok");
    expect(severityFor(disk, 85)).toBe("warn"); // warn 80, crit 90
    expect(severityFor(disk, 95)).toBe("crit");
  });

  it("returns unknown, never ok, when there is no value", () => {
    // A tile with nothing behind it must not render green. Green is a claim.
    expect(severityFor(disk, null)).toBe("unknown");
    expect(severityFor(disk, undefined)).toBe("unknown");
    expect(severityFor(disk, NaN)).toBe("unknown");
  });

  it("agrees with the alert engine on boolean metrics", () => {
    // The bug this pins: page colouring and alerting had separate copies of the
    // comparison, so a failed job rendered a green tile while a critical alert
    // was open against it.
    const failed = getMetric("job.last_run_failed")!;
    expect(severityFor(failed, 1)).toBe("crit");
    expect(severityFor(failed, 0)).toBe("ok");
  });

  it("never alerts on a neutral metric", () => {
    const uptime = getMetric("app.uptime_s")!;
    expect(severityFor(uptime, 999_999_999)).toBe("ok");
  });
});

describe("severityForRule", () => {
  // The shape the alert engine loads out of ops_alert_rules.
  const rule = (over: Partial<Parameters<typeof severityForRule>[0]> = {}) => ({
    metric_key: "host.disk_used_pct",
    comparator: "gt",
    warn_threshold: 80,
    crit_threshold: 90,
    ...over,
  });

  it("reports crit before warn when a value passes both", () => {
    // Checking warn first would report the lesser severity for the worse
    // condition — the alert would open as a warning during an outage.
    expect(severityForRule(rule(), 95)).toEqual({ severity: "crit", threshold: 90 });
    expect(severityForRule(rule(), 85)).toEqual({ severity: "warn", threshold: 80 });
    expect(severityForRule(rule(), 50)).toBeNull();
  });

  it("honours an edited rule that differs from the registry default", () => {
    // Rules are editable on /operations/alerts; the engine must use the ROW,
    // not the registry seed it started from.
    expect(severityForRule(rule({ warn_threshold: 1, crit_threshold: 2 }), 15))
      .toEqual({ severity: "crit", threshold: 2 });
  });

  it("treats a cleared threshold as no breach at that level", () => {
    // Blank in the editor means "no threshold here" — a metric may warn but
    // never escalate.
    expect(severityForRule(rule({ crit_threshold: null }), 95))
      .toEqual({ severity: "warn", threshold: 80 });
    expect(
      severityForRule(rule({ warn_threshold: null, crit_threshold: null }), 999),
    ).toBeNull();
  });

  it("fires on a boolean metric sitting exactly on its threshold", () => {
    // The regression: job.last_run_failed = 1 against warn = crit = 1.
    expect(
      severityForRule(
        { metric_key: "job.last_run_failed", comparator: "gt", warn_threshold: 1, crit_threshold: 1 },
        1,
      ),
    ).toEqual({ severity: "crit", threshold: 1 });
  });

  it("handles the lt direction", () => {
    expect(
      severityForRule(
        { metric_key: "host.cert_days_left", comparator: "lt", warn_threshold: 21, crit_threshold: 7 },
        3,
      ),
    ).toEqual({ severity: "crit", threshold: 7 });
  });
});

describe("thresholdOrderError", () => {
  /**
   * The failure this guards, applied to a hand-written ops_alert_rules row
   * rather than a registry entry: severityForRule checks crit FIRST, so a warn
   * on the wrong side of crit is never reachable — the value trips critical on
   * its way past. The rule looks perfectly reasonable on /operations/alerts.
   */

  it("accepts a correctly ordered 'lt' rule (fires below, higher is better)", () => {
    // Credits falling: warn at 40k, then crit at 15k.
    expect(thresholdOrderError("lt", 40_000, 15_000)).toBeNull();
  });

  it("rejects an inverted 'lt' rule", () => {
    expect(thresholdOrderError("lt", 15_000, 40_000)).toMatch(/at or above crit/);
  });

  it("accepts a correctly ordered 'gt' rule (fires above, lower is better)", () => {
    // Disk filling: warn at 80%, then crit at 92%.
    expect(thresholdOrderError("gt", 80, 92)).toBeNull();
  });

  it("rejects an inverted 'gt' rule", () => {
    expect(thresholdOrderError("gt", 92, 80)).toMatch(/at or below crit/);
  });

  it("allows warn and crit to be equal", () => {
    // job.last_run_failed and app.redis_circuit_open are exactly this: warn ==
    // crit == 1, meaning "1 is the broken state".
    expect(thresholdOrderError("gt", 1, 1)).toBeNull();
    expect(thresholdOrderError("lt", 1, 1)).toBeNull();
  });

  it("says nothing when either threshold is absent", () => {
    // A rule may legitimately warn but never escalate, or escalate with no
    // warning step. Neither is an ordering error.
    expect(thresholdOrderError("gt", 80, null)).toBeNull();
    expect(thresholdOrderError("gt", null, 92)).toBeNull();
    expect(thresholdOrderError("lt", null, null)).toBeNull();
    expect(thresholdOrderError("gt", undefined, undefined)).toBeNull();
  });

  it("treats any non-'lt' comparator as 'gt'", () => {
    // severityForRule normalises the same way — `rule.comparator === "lt" ? …`
    // — so an unexpected value must not silently flip the check.
    expect(thresholdOrderError("", 92, 80)).toMatch(/at or below crit/);
    expect(thresholdOrderError("garbage", 92, 80)).toMatch(/at or below crit/);
  });

  it("agrees with every registry default", () => {
    // The registry's own ordering test and this one must not disagree, or a
    // seeded rule would be rejected the first time someone edited it.
    for (const m of METRICS) {
      expect(
        thresholdOrderError(comparatorFor(m), m.warn ?? null, m.crit ?? null),
        m.key,
      ).toBeNull();
    }
  });
});
