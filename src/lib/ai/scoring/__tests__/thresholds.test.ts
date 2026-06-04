import { describe, it, expect } from "vitest";
import { INTENT_THRESHOLDS, leadStatusFor, decideRoute } from "../thresholds";

// Routing AND the status label must read the SAME threshold table — this is the
// test that locks out the historical 80-vs-75 / 50-vs-40 drift.
describe("single threshold table", () => {
  const ACTION_FOR_STATUS = {
    qualified: "push_to_crm",
    warm: "schedule_call",
    cold: "follow_up",
    disqualified: "stop",
  } as const;

  it("routing status === leadStatusFor for the same score (no overrides)", () => {
    for (let score = 0; score <= 100; score++) {
      const status = leadStatusFor(score);
      const route = decideRoute(score, null);
      expect(route.status).toBe(status);
      expect(route.action).toBe(ACTION_FOR_STATUS[status]);
    }
  });

  it("tier boundaries are exactly INTENT_THRESHOLDS", () => {
    expect(leadStatusFor(INTENT_THRESHOLDS.QUALIFIED)).toBe("qualified");
    expect(leadStatusFor(INTENT_THRESHOLDS.QUALIFIED - 1)).toBe("warm");
    expect(leadStatusFor(INTENT_THRESHOLDS.WARM)).toBe("warm");
    expect(leadStatusFor(INTENT_THRESHOLDS.WARM - 1)).toBe("cold");
    expect(leadStatusFor(INTENT_THRESHOLDS.COLD)).toBe("cold");
    expect(leadStatusFor(INTENT_THRESHOLDS.COLD - 1)).toBe("disqualified");
  });

  it("the qualified gate downgrades a high score to warm", () => {
    expect(leadStatusFor(90, { qualified_gate: false })).toBe("warm");
    expect(leadStatusFor(90, { qualified_gate: true })).toBe("qualified");
  });

  it("hard negatives force disqualified regardless of score", () => {
    expect(leadStatusFor(95, { do_not_call: true })).toBe("disqualified");
    expect(leadStatusFor(95, { explicit_not_interested: true })).toBe("disqualified");
  });
});
