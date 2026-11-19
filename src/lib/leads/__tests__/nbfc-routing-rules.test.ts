import { describe, expect, it } from "vitest";

import {
  describeRuleScope,
  pickRoutingRule,
  ruleMatches,
  ruleWeight,
  validateRuleScope,
  type RoutingRuleScope,
} from "../nbfc-routing-rules";

const rule = (id: number, over: Partial<RoutingRuleScope>): RoutingRuleScope => ({
  id,
  dealer_code: null,
  state: null,
  city: null,
  product_category: null,
  ...over,
});
const lead = { dealer_id: "ACC-1", state: "Maharashtra", city: "Pune", category: "3W" };

describe("E-391 routing rules — matching", () => {
  it("blank fields match anything", () => {
    expect(ruleMatches(rule(1, { product_category: "3W" }), lead)).toBe(true);
    expect(ruleMatches(rule(1, { state: "Maharashtra" }), lead)).toBe(true);
  });
  it("every set field must match, case- and space-insensitive", () => {
    expect(ruleMatches(rule(1, { state: " maharashtra ", city: "PUNE" }), lead)).toBe(true);
    expect(ruleMatches(rule(1, { state: "Maharashtra", city: "Nashik" }), lead)).toBe(false);
    expect(ruleMatches(rule(1, { dealer_code: "ACC-2", product_category: "3W" }), lead)).toBe(false);
  });
  it("a lead with no category never matches a category rule", () => {
    expect(ruleMatches(rule(1, { product_category: "3W" }), { ...lead, category: null })).toBe(false);
  });
});

describe("E-391 routing rules — most specific wins", () => {
  it("weights dealer > city > state > category", () => {
    expect(ruleWeight(rule(1, { dealer_code: "x" }))).toBeGreaterThan(ruleWeight(rule(2, { state: "a", city: "b", product_category: "c" })));
  });
  it("picks the most specific matching rule", () => {
    const rules = [
      rule(1, { product_category: "3W" }),
      rule(2, { state: "Maharashtra" }),
      rule(3, { state: "Maharashtra", city: "Pune" }),
      rule(4, { dealer_code: "ACC-1" }),
      rule(5, { dealer_code: "ACC-2" }),
    ];
    expect(pickRoutingRule(rules, lead)?.id).toBe(4);
    expect(pickRoutingRule(rules.slice(0, 3), lead)?.id).toBe(3);
  });
  it("breaks a tie by the newest rule", () => {
    expect(pickRoutingRule([rule(7, { product_category: "3W" }), rule(9, { product_category: "3w" })], lead)?.id).toBe(9);
  });
  it("returns null when nothing matches", () => {
    expect(pickRoutingRule([rule(1, { city: "Nashik", state: "Maharashtra" })], lead)).toBeNull();
    expect(pickRoutingRule([], lead)).toBeNull();
  });
});

describe("E-391 routing rules — scope validation and wording", () => {
  it("needs at least one field, and a state for a city", () => {
    expect(validateRuleScope({}).ok).toBe(false);
    expect(validateRuleScope({ city: "Pune" }).ok).toBe(false);
    expect(validateRuleScope({ city: "Pune", state: "Maharashtra" }).ok).toBe(true);
    expect(validateRuleScope({ product_category: "3W" }).ok).toBe(true);
  });
  it("describes the scope", () => {
    expect(describeRuleScope(rule(1, { dealer_code: "ACC-1", state: "Maharashtra", product_category: "3W" }), "Acme")).toBe(
      "Dealer Acme · Maharashtra (any city) · 3W",
    );
  });
});
