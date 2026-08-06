import { describe, expect, it } from "vitest";

import {
  ANY_SOURCE,
  candidatesForRule,
  shadowedSources,
  type RoutableRule,
} from "../alertRouting";

/**
 * The property these tests exist to protect:
 *
 *   For any (metric_key, source), EXACTLY ONE rule evaluates it.
 *
 * ops_alerts dedups on (metric_key, source) WHERE resolved_at IS NULL, so a
 * single alert row represents that pair. Two rules acting on it is not a
 * cosmetic problem: when they disagree, one opens the alert and the other
 * resolves it on the same tick, forever, and because each resolve frees the
 * partial unique index the next open INSERTs a fresh row with notified_at NULL
 * — so the cooldown never engages and every tick notifies twice.
 */

const sample = (source: string, value = 1) => ({ source, value });

describe("shadowedSources", () => {
  it("collects specific sources per metric and ignores the wildcard", () => {
    const rules: RoutableRule[] = [
      { metric_key: "vendor.credits_remaining", source: ANY_SOURCE },
      { metric_key: "vendor.credits_remaining", source: "vendor:elevenlabs" },
      { metric_key: "host.disk_used_pct", source: "host:prod" },
      { metric_key: "host.disk_used_pct", source: "host:iot" },
    ];

    const shadowed = shadowedSources(rules);
    expect([...(shadowed.get("vendor.credits_remaining") ?? [])]).toEqual([
      "vendor:elevenlabs",
    ]);
    expect([...(shadowed.get("host.disk_used_pct") ?? [])].sort()).toEqual([
      "host:iot",
      "host:prod",
    ]);
  });

  it("returns an empty map when every rule is a wildcard", () => {
    // The state the system has always been in until now.
    const rules: RoutableRule[] = [
      { metric_key: "a.b", source: ANY_SOURCE },
      { metric_key: "c.d", source: ANY_SOURCE },
    ];
    expect(shadowedSources(rules).size).toBe(0);
  });
});

describe("candidatesForRule", () => {
  const samples = [
    sample("vendor:elevenlabs"),
    sample("vendor:bolna"),
    sample("vendor:openai"),
  ];

  it("gives a specific rule only its own source", () => {
    const rule = { metric_key: "m", source: "vendor:elevenlabs" };
    expect(
      candidatesForRule(rule, samples, new Set(["vendor:elevenlabs"])).map(
        (s) => s.source,
      ),
    ).toEqual(["vendor:elevenlabs"]);
  });

  it("gives the wildcard every source when nothing is shadowed", () => {
    const rule = { metric_key: "m", source: ANY_SOURCE };
    expect(candidatesForRule(rule, samples, undefined).map((s) => s.source)).toEqual([
      "vendor:elevenlabs",
      "vendor:bolna",
      "vendor:openai",
    ]);
  });

  it("withholds a shadowed source from the wildcard", () => {
    const rule = { metric_key: "m", source: ANY_SOURCE };
    expect(
      candidatesForRule(rule, samples, new Set(["vendor:elevenlabs"])).map(
        (s) => s.source,
      ),
    ).toEqual(["vendor:bolna", "vendor:openai"]);
  });

  it("returns nothing for a specific rule whose source never reported", () => {
    const rule = { metric_key: "m", source: "vendor:nobody" };
    expect(candidatesForRule(rule, samples, new Set(["vendor:nobody"]))).toEqual([]);
  });
});

describe("the disjointness invariant", () => {
  it("routes every (metric, source) to exactly one rule", () => {
    const rules: RoutableRule[] = [
      { metric_key: "vendor.credits_remaining", source: ANY_SOURCE },
      { metric_key: "vendor.credits_remaining", source: "vendor:elevenlabs" },
    ];
    const samples = [
      sample("vendor:elevenlabs"),
      sample("vendor:bolna"),
      sample("vendor:openai"),
    ];
    const shadowed = shadowedSources(rules);

    // Count how many rules claim each source.
    const claims = new Map<string, number>();
    for (const rule of rules) {
      for (const c of candidatesForRule(
        rule,
        samples,
        shadowed.get(rule.metric_key),
      )) {
        claims.set(c.source, (claims.get(c.source) ?? 0) + 1);
      }
    }

    expect([...claims.entries()].sort()).toEqual([
      ["vendor:bolna", 1],
      ["vendor:elevenlabs", 1],
      ["vendor:openai", 1],
    ]);
  });

  it("shadows per metric, not globally", () => {
    // A per-source override on one metric must not blind the wildcard of a
    // DIFFERENT metric that happens to share the source name.
    const rules: RoutableRule[] = [
      { metric_key: "vendor.credits_remaining", source: "vendor:elevenlabs" },
      { metric_key: "vendor.credits_used_pct", source: ANY_SOURCE },
    ];
    const shadowed = shadowedSources(rules);
    const samples = [sample("vendor:elevenlabs")];

    const pctRule = rules[1]!;
    expect(
      candidatesForRule(pctRule, samples, shadowed.get(pctRule.metric_key)).map(
        (s) => s.source,
      ),
    ).toEqual(["vendor:elevenlabs"]);
  });

  it("hands a source back to the wildcard when its override is disabled", () => {
    // evaluateAlerts() only ever passes enabled rules, so a disabled override
    // simply is not in the list. The source must then fall through to '*'
    // rather than becoming silently unmonitored — the failure mode where
    // someone disables a rule to quiet it and loses the metric entirely.
    const enabledOnly: RoutableRule[] = [
      { metric_key: "vendor.credits_remaining", source: ANY_SOURCE },
      // the vendor:elevenlabs override exists in the table but is disabled,
      // so it is absent here
    ];
    const shadowed = shadowedSources(enabledOnly);
    const samples = [sample("vendor:elevenlabs")];

    expect(
      candidatesForRule(enabledOnly[0]!, samples, shadowed.get("vendor.credits_remaining")).map(
        (s) => s.source,
      ),
    ).toEqual(["vendor:elevenlabs"]);
  });

  it("reproduces the pre-fix collision when routing is ignored", () => {
    // Documents the bug this module exists to prevent: the old filter was
    // `rule.source === '*' || c.source === rule.source`, under which BOTH rules
    // claim vendor:elevenlabs.
    const rules: RoutableRule[] = [
      { metric_key: "m", source: ANY_SOURCE },
      { metric_key: "m", source: "vendor:elevenlabs" },
    ];
    const samples = [sample("vendor:elevenlabs")];

    const oldWay = rules.filter((r) =>
      samples.some((s) => r.source === ANY_SOURCE || s.source === r.source),
    );
    expect(oldWay).toHaveLength(2); // the collision

    const newWay = rules.filter(
      (r) =>
        candidatesForRule(r, samples, shadowedSources(rules).get(r.metric_key))
          .length > 0,
    );
    expect(newWay).toHaveLength(1);
    expect(newWay[0]!.source).toBe("vendor:elevenlabs");
  });
});
