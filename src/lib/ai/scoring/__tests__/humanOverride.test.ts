import { describe, it, expect } from "vitest";
import { computeBand, bandOutcome, type Band } from "../computeBand";
import { bandToStatus, statusToBand, leadStatusFor } from "../thresholds";
import { mk } from "./_fixtures";

// The human override (E-250) writes a band onto the lead directly, without
// going through computeBand — a reviewer picks the answer, there are no signals
// to score. That creates a SECOND path to the same columns, and these tests
// exist to stop the two drifting.
//
// Why it matters concretely: if an AI-produced "Warm" writes 60 and a
// human-corrected "Warm" writes anything else, the two sort differently in
// every queue and every numeric filter, and a future edit to BAND_LEAD_SCORE
// silently fixes only one of them.

const ALL_BANDS: Band[] = ["Qualified", "Warm", "Cold", "Disqualified"];

describe("bandOutcome — the shared band → lead mapping", () => {
  it("returns the SAME lead_score/interest_level computeBand does, for every band", () => {
    // Signal sets chosen to land on each band through the real rule, so this
    // compares the override's table against genuine engine output rather than
    // against itself.
    const cases: Array<{ band: Band; signals: Parameters<typeof computeBand>[0] }> = [
      { band: "Qualified", signals: mk({ spec: true, volume: true, need: true }) },
      { band: "Warm", signals: mk({ spec: true }) },
      { band: "Cold", signals: mk({ pitch: true }) },
      { band: "Disqualified", signals: mk({ relevant: false }) },
    ];

    for (const { band, signals } of cases) {
      const engine = computeBand(signals);
      expect(engine.band).toBe(band);

      const override = bandOutcome(band);
      expect(override.lead_score).toBe(engine.lead_score);
      expect(override.interest_level).toBe(engine.interest_level);
      expect(override.action).toBe(engine.action);
    }
  });

  it("gives every band a score that classifies back to its own status", () => {
    // The override writes both intent_band AND final_intent_score. Downstream
    // readers use whichever is handier, so a band whose score classifies to a
    // DIFFERENT status would make band filters and score filters disagree about
    // the same lead.
    for (const band of ALL_BANDS) {
      const { lead_score } = bandOutcome(band);
      expect(leadStatusFor(lead_score)).toBe(bandToStatus(band));
    }
  });
});

describe("statusToBand — the correction UI's label → canonical band", () => {
  it("round-trips with bandToStatus for every band", () => {
    for (const band of ALL_BANDS) {
      const status = bandToStatus(band);
      expect(status).not.toBeNull();
      expect(statusToBand(status)).toBe(band);
    }
  });

  it("accepts the lowercase labels the four correction buttons actually send", () => {
    expect(statusToBand("qualified")).toBe("Qualified");
    expect(statusToBand("warm")).toBe("Warm");
    expect(statusToBand("cold")).toBe("Cold");
    expect(statusToBand("disqualified")).toBe("Disqualified");
  });

  it("is case-insensitive, so a differently-cased client cannot silently no-op", () => {
    expect(statusToBand("Qualified")).toBe("Qualified");
    expect(statusToBand("WARM")).toBe("Warm");
  });

  it("returns null for anything it does not recognise, including the note sentinel", () => {
    // 'none' is what the Google Sheet importer writes for a reviewer comment
    // that named no band. It must never resolve to a real band — that would
    // turn prose into fabricated ground truth and move a live lead.
    expect(statusToBand("none")).toBeNull();
    expect(statusToBand("")).toBeNull();
    expect(statusToBand(null)).toBeNull();
    expect(statusToBand("hot")).toBeNull();
  });
});
