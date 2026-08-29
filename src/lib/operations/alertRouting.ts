/**
 * Which rule owns which sample.
 *
 * Split out of alerts.ts for the same reason scheduling.ts is split out of
 * runner.ts: alerts.ts imports @/lib/db, which throws at import time without
 * DATABASE_URL, so nothing in it can be unit tested. The routing decision is
 * the part with the sharp edge, so it lives here and is covered by
 * __tests__/alertRouting.test.ts.
 *
 * THE RULE: a rule scoped to a specific source SHADOWS the '*' rule for that
 * source, and only for that source. Every other source still falls through to
 * '*'.
 *
 * Why this has to exist. ops_alert_rules is unique on (metric_key, source) and
 * ops_alerts dedups on (metric_key, source) WHERE resolved_at IS NULL — one
 * open alert per problem. Before this, evaluateAlerts() matched every rule
 * independently, so a '*' rule and a 'vendor:elevenlabs' rule for the same
 * metric would BOTH evaluate the ElevenLabs sample and both act on that single
 * alert row. Whenever they disagreed — which is the entire point of having a
 * per-source override — one opened the alert and the other resolved it, every
 * 60-second tick, forever. And because each cycle resolves the row, the next
 * open INSERTs a fresh one with notified_at NULL, so the cooldown never
 * engages and every tick notifies twice.
 *
 * No per-source rule has ever existed (seedAlertRules only writes '*', and the
 * rules API deliberately refuses to write metric_key/source/comparator), so
 * that was latent rather than live. This makes per-source rules safe to create.
 */

/** The fields routing cares about. The real RuleRow carries more. */
export interface RoutableRule {
  metric_key: string;
  source: string;
}

/** The wildcard source: "this rule covers every source of its metric". */
export const ANY_SOURCE = "*";

/**
 * Per metric_key, the set of sources that carry their own rule.
 *
 * Pass ONLY enabled rules. That is deliberate and is the useful behaviour:
 * disabling a per-source override hands its source back to the '*' rule,
 * rather than leaving it silently unmonitored.
 */
export function shadowedSources(
  rules: readonly RoutableRule[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const rule of rules) {
    if (rule.source === ANY_SOURCE) continue;
    const set = out.get(rule.metric_key) ?? new Set<string>();
    set.add(rule.source);
    out.set(rule.metric_key, set);
  }
  return out;
}

/**
 * The samples this rule is responsible for evaluating.
 *
 * A specific rule takes its own source and nothing else. The '*' rule takes
 * every source EXCEPT those a specific rule has claimed. The two are therefore
 * disjoint by construction, which is what guarantees exactly one rule acts on
 * any (metric_key, source) — and so on any one alert row.
 */
export function candidatesForRule<S extends { source: string }>(
  rule: RoutableRule,
  samples: readonly S[],
  shadowed: ReadonlySet<string> | undefined,
): S[] {
  if (rule.source !== ANY_SOURCE) {
    return samples.filter((s) => s.source === rule.source);
  }
  return samples.filter((s) => !shadowed?.has(s.source));
}
