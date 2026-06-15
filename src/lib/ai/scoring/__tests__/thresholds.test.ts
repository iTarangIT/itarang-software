import { describe, it, expect } from "vitest";
import { INTENT_THRESHOLDS, leadStatusFor, bandToStatus } from "../thresholds";
import { computeBand } from "../computeBand";
import { mk } from "./_fixtures";

// The band's lead_score (90/60/30/0) rides in the numeric field, so the numeric
// classifier must agree with the band it came from — this locks the carried
// score to the same tier so every downstream bucket/sort stays correct.
describe("score↔band agreement", () => {
  it("each band's lead_score classifies back to the same status", () => {
    const cases: Array<[ReturnType<typeof computeBand>["band"], string]> = [
      [computeBand(mk({ spec: true, volume: true, need: true })).band, "qualified"], // 90
      [computeBand(mk({ volume: true })).band, "warm"], // 60
      [computeBand(mk({ pitch: true })).band, "cold"], // 30
      [computeBand(mk({ relevant: false })).band, "disqualified"], // 0
    ];
    expect(leadStatusFor(90)).toBe("qualified");
    expect(leadStatusFor(60)).toBe("warm");
    expect(leadStatusFor(30)).toBe("cold");
    expect(leadStatusFor(0)).toBe("disqualified");
    for (const [band, status] of cases) {
      expect(bandToStatus(band)).toBe(status);
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

  it("bandToStatus returns null for a missing band (dropped_empty)", () => {
    expect(bandToStatus(null)).toBe(null);
  });
});
