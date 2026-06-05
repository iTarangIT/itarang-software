import { describe, it, expect } from "vitest";
import { computeIntentScore } from "../computeIntentScore";
import { SIGNAL_WEIGHTS, MAX_POSITIVE_SCORE } from "../weights";
import { mk } from "./_fixtures";

// The whole point of the refactor: the breakdown is truthful — its
// contributions sum EXACTLY to the headline score (incl. the cap line).
describe("score_breakdown integrity", () => {
  const fixtures = [
    mk(),
    mk({ engagement: "weak", timeline: "later", callback: true }),
    mk({ need: "moderate", budget: "weak", engagement: "moderate", curiosity: "moderate" }),
    mk({
      need: "strong",
      budget: "strong",
      engagement: "strong",
      curiosity: "strong",
      timeline: "now",
      objection: "substantive",
    }),
    mk({ need: "strong", budget: "strong", competitor_bought: true }),
    mk({ need: "moderate", do_not_call: true }),
    mk({ need: "weak", hostile: true }),
    mk({ need: "strong", too_short: true }),
  ];

  it("contributions sum to intent_score for every fixture", () => {
    for (const f of fixtures) {
      const r = computeIntentScore(f);
      const sum = r.score_breakdown.reduce((acc, c) => acc + c.contribution, 0);
      expect(sum).toBe(r.intent_score);
    }
  });

  it("the positive weight table totals 100", () => {
    const total = Object.values(SIGNAL_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBe(MAX_POSITIVE_SCORE);
  });

  it("scores are always within [0, 100]", () => {
    for (const f of fixtures) {
      const r = computeIntentScore(f);
      expect(r.intent_score).toBeGreaterThanOrEqual(0);
      expect(r.intent_score).toBeLessThanOrEqual(100);
    }
  });
});
