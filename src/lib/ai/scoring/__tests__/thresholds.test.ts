import { describe, it, expect } from "vitest";
import { INTENT_THRESHOLDS, leadStatusFor, bandToStatus } from "../thresholds";
import { computeBand } from "../computeBand";
import { mk } from "./_fixtures";

// The band's lead_score (90/75/30/0 from the AI; 60 for a human Warm) rides in
// the numeric field, so the numeric classifier must agree with the band it came
// from — this locks the carried score to the same tier so every downstream
// bucket/sort stays correct.
describe("score↔band agreement", () => {
  it("each band's lead_score classifies back to the same status", () => {
    const results = [
      computeBand(mk({ lithium: "yes", volume: true })), // Qualified 90
      computeBand(mk({ lithium: "yes" })), // Qualified 75
      computeBand(mk({ pitch: true })), // Cold 30
      computeBand(mk({ lithium: "no" })), // Disqualified 0
    ];
    expect(results.map((r) => r.lead_score)).toEqual([90, 75, 30, 0]);
    for (const r of results) {
      expect(leadStatusFor(r.lead_score)).toBe(bandToStatus(r.band));
    }
    expect(leadStatusFor(60)).toBe("warm"); // human-override Warm
  });

  it("tier boundaries are exactly INTENT_THRESHOLDS", () => {
    expect(leadStatusFor(INTENT_THRESHOLDS.QUALIFIED)).toBe("qualified");
    expect(leadStatusFor(INTENT_THRESHOLDS.QUALIFIED - 1)).toBe("warm");
    expect(leadStatusFor(INTENT_THRESHOLDS.WARM)).toBe("warm");
    expect(leadStatusFor(INTENT_THRESHOLDS.WARM - 1)).toBe("cold");
    expect(leadStatusFor(INTENT_THRESHOLDS.COLD)).toBe("cold");
    expect(leadStatusFor(INTENT_THRESHOLDS.COLD - 1)).toBe("disqualified");
  });

  it("bandToStatus returns null for a missing band (dropped_empty)", () => {
    expect(bandToStatus(null)).toBe(null);
  });
});
