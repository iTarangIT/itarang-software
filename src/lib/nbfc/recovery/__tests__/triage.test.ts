import { describe, expect, it } from "vitest";
import { allowedChoices, healthPct, suggestTriage, TRIAGE_FIT_MIN_PCT, TRIAGE_REFURB_MIN_PCT } from "../triage-rules";

describe("recovery triage (E-292, v3 R2/R3)", () => {
  it("computes health % = measured / rated, one decimal", () => {
    expect(healthPct(40, 51)).toBe(78.4);
    expect(healthPct(35, 51)).toBe(68.6);
    expect(healthPct(51, 51)).toBe(100);
    expect(healthPct(0, 51)).toBe(0);
    expect(healthPct(null, 51)).toBeNull();
    expect(healthPct(40, 0)).toBeNull();
    expect(healthPct(-1, 51)).toBeNull();
  });

  it("suggests the branch from the 51 V worked example, as ratios", () => {
    expect(TRIAGE_FIT_MIN_PCT).toBe(78.4);
    expect(TRIAGE_REFURB_MIN_PCT).toBe(70);
    expect(suggestTriage(healthPct(41, 51))).toBe("fit_as_is"); // > 40 V
    expect(suggestTriage(healthPct(40, 51))).toBe("fit_as_is"); // 40 V on the line
    expect(suggestTriage(healthPct(38, 51))).toBe("refurbish"); // 35–40 V
    expect(suggestTriage(healthPct(35.7, 51))).toBe("refurbish"); // 70.0 %
    expect(suggestTriage(healthPct(35, 51))).toBe("scrap"); // 68.6 % — under the floor
    expect(suggestTriage(healthPct(30, 51))).toBe("scrap");
    expect(suggestTriage(null)).toBeNull();
    // a 48 V pack is judged the same way
    expect(suggestTriage(healthPct(38, 48))).toBe("fit_as_is");
    expect(suggestTriage(healthPct(35, 48))).toBe("refurbish");
    expect(suggestTriage(healthPct(33, 48))).toBe("scrap");
  });

  it("gates refurbish at 70 % and leaves the rest to the NBFC", () => {
    expect(allowedChoices(80)).toEqual(["auction", "redeploy", "refurbish", "scrap"]);
    expect(allowedChoices(70)).toEqual(["auction", "redeploy", "refurbish", "scrap"]);
    expect(allowedChoices(69.9)).toEqual(["auction", "redeploy", "scrap"]);
    expect(allowedChoices(null)).toEqual(["auction", "redeploy", "scrap"]);
  });
});
