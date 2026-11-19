/**
 * E-391 — Battery Pool diagram 1, part 2: which NBFC routing rule fits a lead.
 * Pure (no I/O; unit-tested in __tests__/nbfc-routing-rules.test.ts). The DB +
 * BRE side lives in ./nbfc-routing.ts.
 *
 * A rule sets any mix of dealer, customer state, customer city and product
 * category; a blank field matches anything. Every field the rule DOES set must
 * equal the lead's (trimmed, case-insensitive). Among the rules that match, the
 * most specific wins: dealer 8, city 4, state 2, category 1; a tie goes to the
 * newest rule.
 */

export interface RoutingRuleScope {
  id: number;
  dealer_code: string | null;
  state: string | null;
  city: string | null;
  product_category: string | null;
}

export interface RoutingLead {
  dealer_id: string | null;
  state: string | null;
  city: string | null;
  /** product_categories.name, e.g. "3W". */
  category: string | null;
}

const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

function fieldMatches(ruleValue: string | null, leadValue: string | null): boolean {
  const r = norm(ruleValue);
  if (!r) return true;
  return r === norm(leadValue);
}

export function ruleMatches(rule: RoutingRuleScope, lead: RoutingLead): boolean {
  return (
    fieldMatches(rule.dealer_code, lead.dealer_id) &&
    fieldMatches(rule.state, lead.state) &&
    fieldMatches(rule.city, lead.city) &&
    fieldMatches(rule.product_category, lead.category)
  );
}

export function ruleWeight(rule: RoutingRuleScope): number {
  return (
    (norm(rule.dealer_code) ? 8 : 0) +
    (norm(rule.city) ? 4 : 0) +
    (norm(rule.state) ? 2 : 0) +
    (norm(rule.product_category) ? 1 : 0)
  );
}

/** The most specific matching rule, or null. */
export function pickRoutingRule<T extends RoutingRuleScope>(rules: T[], lead: RoutingLead): T | null {
  let best: T | null = null;
  for (const r of rules) {
    if (!ruleMatches(r, lead)) continue;
    if (!best) {
      best = r;
      continue;
    }
    const w = ruleWeight(r);
    const bw = ruleWeight(best);
    if (w > bw || (w === bw && r.id > best.id)) best = r;
  }
  return best;
}

/** "Dealer X · Pune, Maharashtra · 3W" — for the admin table and the audit. */
export function describeRuleScope(rule: RoutingRuleScope, dealerName?: string | null): string {
  const parts: string[] = [];
  if (norm(rule.dealer_code)) parts.push(`Dealer ${dealerName || rule.dealer_code}`);
  if (norm(rule.city)) parts.push(`${rule.city}, ${rule.state}`);
  else if (norm(rule.state)) parts.push(`${rule.state} (any city)`);
  if (norm(rule.product_category)) parts.push(rule.product_category!.trim());
  return parts.join(" · ") || "Any";
}

/** Validates a new rule's scope. */
export function validateRuleScope(s: {
  dealer_code?: string | null;
  state?: string | null;
  city?: string | null;
  product_category?: string | null;
}): { ok: true } | { ok: false; message: string } {
  if (![s.dealer_code, s.state, s.city, s.product_category].some((v) => norm(v))) {
    return { ok: false, message: "Set at least one of dealer, state, city or product category." };
  }
  if (norm(s.city) && !norm(s.state)) return { ok: false, message: "Pick the state for this city." };
  return { ok: true };
}
