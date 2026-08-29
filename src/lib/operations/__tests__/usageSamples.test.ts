import { describe, expect, it } from "vitest";

import { getMetric } from "../registry";
import {
  buildUsageSamples,
  numFrom,
  USAGE_SAMPLE_KEYS,
  USAGE_SOURCE,
} from "../usageSamples";

/**
 * THE PRIVACY INVARIANT.
 *
 * /operations/usage is the only per-person surface in this console. The promise
 * that makes it defensible — written into drizzle/E-214_usage_analytics.sql, §8
 * of the Ops Runbook, and the notice shown on the page itself — is that the
 * COLLECTOR writes aggregates only: no per-person row ever reaches
 * ops_metric_samples or ops_daily_snapshots, which are never pruned. Per-person
 * data lives only in tables that expire.
 *
 * Those documents claimed a test enforced this. None did, and none could:
 * collectors/usage.ts imports @/lib/db, which throws at import time without
 * DATABASE_URL, so vitest could never load it. The guarantee was prose.
 *
 * This is that test. If it starts failing, something has crossed the line
 * between "how much is the CRM used" and "what did this person do today".
 */

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** A full, healthy set of query results. */
const FULL = Object.fromEntries(
  USAGE_SAMPLE_KEYS.map((k, i) => [k, i + 1]),
) as Record<(typeof USAGE_SAMPLE_KEYS)[number], number>;

describe("the aggregate-only invariant", () => {
  it("emits EVERY sample under the single source usage:all", () => {
    const samples = buildUsageSamples(FULL);
    expect(samples.length).toBeGreaterThan(0);
    for (const s of samples) {
      expect(s.source, `${s.metric_key} source`).toBe(USAGE_SOURCE);
    }
  });

  it("never emits a source containing a user id", () => {
    // The shape a per-person leak would take: "usage:<uuid>", or a uuid smuggled
    // into the metric key. Checked on both, because either would end up in a
    // table that is never pruned.
    for (const s of buildUsageSamples(FULL)) {
      expect(UUID_RE.test(s.source), `${s.source} looks like a user id`).toBe(
        false,
      );
      expect(UUID_RE.test(s.metric_key)).toBe(false);
    }
  });

  it("carries no per-person payload on any sample", () => {
    // value_text and meta are the two free-form fields on ops_metric_samples.
    // Neither is used here, and neither should silently start being used.
    for (const s of buildUsageSamples(FULL)) {
      expect(s.value_text).toBeUndefined();
      expect(s.meta).toBeUndefined();
      expect(typeof s.value_num).toBe("number");
    }
  });

  it("emits only keys that are declared in the registry", () => {
    // A sample whose key has no MetricDef renders nowhere and alerts on nothing,
    // so it would be silently collected data with no purpose — the exact thing
    // the E-214 reasoning rejects.
    for (const s of buildUsageSamples(FULL)) {
      expect(getMetric(s.metric_key)?.key, `${s.metric_key} missing`).toBe(
        s.metric_key,
      );
    }
  });

  it("declares every key under the usage module", () => {
    for (const key of USAGE_SAMPLE_KEYS) {
      expect(getMetric(key)?.module, `${key} module`).toBe("usage");
    }
  });
});

describe("buildUsageSamples — failure is not zero", () => {
  it("omits a sample whose query failed rather than reporting 0", () => {
    // A confident zero on a dead pipeline renders GREEN. Omitting the sample
    // leaves the tile stale, which severityFor() reports as "unknown".
    const samples = buildUsageSamples({ ...FULL, "usage.dau": null });
    expect(samples.map((s) => s.metric_key)).not.toContain("usage.dau");
    expect(samples).toHaveLength(USAGE_SAMPLE_KEYS.length - 1);
  });

  it("distinguishes a genuine zero from a failure", () => {
    // Nobody signed in today IS a real reading and must be recorded.
    const samples = buildUsageSamples({ "usage.logins_24h": 0 });
    expect(samples).toHaveLength(1);
    expect(samples[0]!.value_num).toBe(0);
  });

  it("drops non-finite values instead of writing NaN into the series", () => {
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      expect(buildUsageSamples({ "usage.dau": bad })).toEqual([]);
    }
  });

  it("returns an empty array when every query failed", () => {
    // This is what tracking-off and a total outage both look like: no samples,
    // no zeros, nothing claimed.
    const allNull = Object.fromEntries(
      USAGE_SAMPLE_KEYS.map((k) => [k, null]),
    );
    expect(buildUsageSamples(allNull)).toEqual([]);
    expect(buildUsageSamples({})).toEqual([]);
  });
});

describe("numFrom", () => {
  const ok = (rows: Array<Record<string, unknown>>) =>
    ({ status: "fulfilled", value: rows }) as const;

  it("reads the named column", () => {
    expect(numFrom(ok([{ n: 7 }]), "n")).toBe(7);
    // Postgres bigint/numeric arrive as strings through the driver.
    expect(numFrom(ok([{ n: "42" }]), "n")).toBe(42);
  });

  it("returns null — not 0 — for a rejected query", () => {
    const rejected = {
      status: "rejected",
      reason: new Error("relation does not exist"),
    } as const;
    expect(numFrom(rejected, "n")).toBeNull();
  });

  it("returns null for an empty result set or a missing column", () => {
    expect(numFrom(ok([]), "n")).toBeNull();
    expect(numFrom(ok([{ other: 1 }]), "n")).toBeNull();
    expect(numFrom(ok([{ n: null }]), "n")).toBeNull();
  });

  it("returns null for a non-numeric value", () => {
    expect(numFrom(ok([{ n: "not a number" }]), "n")).toBeNull();
  });

  it("preserves a real zero", () => {
    expect(numFrom(ok([{ n: 0 }]), "n")).toBe(0);
  });
});
