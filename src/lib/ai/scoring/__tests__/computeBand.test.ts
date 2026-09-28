import { describe, it, expect } from "vitest";
import { computeBand, VOLUME_BONUS } from "../computeBand";
import { deriveOutcome } from "../legacyAnalysis";
import { mk } from "./_fixtures";

// The band rule (qualification-2.0.0 — the lithium-dealer rule). Top rule wins.
// These pin production behaviour — any change to the rule must update these on
// purpose.
describe("computeBand — the lithium-dealer rule (top rule wins)", () => {
  it("lithium yes → Qualified 75 (qualified/push_to_crm)", () => {
    const r = computeBand(mk({ lithium: "yes" }));
    expect(r.band).toBe("Qualified");
    expect(r.lead_score).toBe(75);
    expect(r.interest_level).toBe("hot");
    expect(r.action).toBe("push_to_crm");
    expect(r.call_status).toBe("complete");
    expect(r.hard_negative).toBe(false);
  });

  it("lithium yes + monthly volume → Qualified 90", () => {
    const r = computeBand(mk({ lithium: "yes", volume: true }));
    expect(r.band).toBe("Qualified");
    expect(r.lead_score).toBe(75 + VOLUME_BONUS);
    expect(r.lead_score).toBe(90);
  });

  it("other info signals do NOT move the score — only volume does", () => {
    const r = computeBand(
      mk({ lithium: "yes", spec: true, financier: true, need: true, value: true }),
    );
    expect(r.band).toBe("Qualified");
    expect(r.lead_score).toBe(75);
    expect(r.info_signals_count).toBe(4); // still counted for audit
  });

  it("lithium no → Disqualified 0, overriding callback + volume", () => {
    const r = computeBand(
      mk({ lithium: "no", callback: true, spec: true, volume: true, need: true }),
    );
    expect(r.band).toBe("Disqualified");
    expect(r.lead_score).toBe(0);
    expect(r.interest_level).toBe(null);
    expect(r.action).toBe("stop");
    expect(r.hard_negative).toBe(true);
  });

  it("lithium never answered → Cold 30, even with callback + substance", () => {
    for (const signals of [
      mk({ pitch: true }),
      mk({ callback: true }),
      mk({ spec: true, volume: true, need: true }),
    ]) {
      const r = computeBand(signals);
      expect(r.band).toBe("Cold");
      expect(r.lead_score).toBe(30);
      expect(r.interest_level).toBe("cold");
      expect(r.action).toBe("follow_up");
      expect(r.hard_negative).toBe(false);
    }
  });

  it("the AI never produces Warm", () => {
    for (const lithium of ["yes", "no", "unknown"] as const) {
      for (const volume of [true, false]) {
        expect(computeBand(mk({ lithium, volume, spec: true })).band).not.toBe("Warm");
      }
    }
  });

  it("relevant_dealer no longer gates the band", () => {
    expect(computeBand(mk({ lithium: "yes", relevant: false })).band).toBe("Qualified");
  });

  it("hard disqualifier beats a lithium yes", () => {
    for (const d of ["dont_call", "hostile", "not_interested"] as const) {
      const r = computeBand(mk({ lithium: "yes", volume: true, disqualifier: d }));
      expect(r.band).toBe("Disqualified");
      expect(r.lead_score).toBe(0);
      expect(r.hard_negative).toBe(true);
      expect(r.action).toBe("stop");
    }
  });
});

describe("computeBand — dropped calls", () => {
  it("dropped_empty: lithium unknown + 0 info + no callback → no band, auto_retry", () => {
    const r = computeBand(mk({ relevant: false, disqualifier: "call_dropped" }));
    expect(r.band).toBe(null);
    expect(r.call_status).toBe("dropped_empty");
    expect(r.action).toBe("auto_retry");
    expect(r.lead_score).toBe(0);
    expect(r.hard_negative).toBe(false); // untouched, not demoted
  });

  it("dropped after a lithium yes + volume → dropped_partial Qualified 90", () => {
    const r = computeBand(mk({ disqualifier: "call_dropped", lithium: "yes", volume: true }));
    expect(r.call_status).toBe("dropped_partial");
    expect(r.band).toBe("Qualified");
    expect(r.lead_score).toBe(90);
  });

  it("dropped after a lithium no → dropped_partial Disqualified", () => {
    const r = computeBand(mk({ disqualifier: "call_dropped", lithium: "no" }));
    expect(r.call_status).toBe("dropped_partial");
    expect(r.band).toBe("Disqualified");
  });

  it("dropped with substance but no lithium answer → dropped_partial Cold", () => {
    const r = computeBand(mk({ disqualifier: "call_dropped", volume: true }));
    expect(r.call_status).toBe("dropped_partial");
    expect(r.band).toBe("Cold");
  });
});

describe("computeBand — info_signals_count & breakdown", () => {
  it("counts exactly the five info signals (0–5)", () => {
    expect(
      computeBand(
        mk({ spec: true, volume: true, financier: true, need: true, value: true }),
      ).info_signals_count,
    ).toBe(5);
    expect(computeBand(mk()).info_signals_count).toBe(0);
    // lithium/pitch/callback/relevant are NOT info signals.
    expect(
      computeBand(mk({ lithium: "yes", pitch: true, callback: true, relevant: true }))
        .info_signals_count,
    ).toBe(0);
  });

  it("breakdown leads with the lithium row, then one row per info signal", () => {
    const r = computeBand(mk({ lithium: "yes", spec: true, volume: false }));
    expect(r.score_breakdown[0].signal).toBe("lithium_dealer");
    expect(r.score_breakdown[0].present).toBe(true);
    const infoRows = r.score_breakdown.filter((l) => l.info);
    expect(infoRows).toHaveLength(5);
    expect(infoRows.find((l) => l.signal === "battery_spec_shared")?.present).toBe(true);
    expect(infoRows.find((l) => l.signal === "volume_shared")?.present).toBe(false);
  });

  it("lithium row is not present for no or unknown", () => {
    expect(computeBand(mk({ lithium: "no" })).score_breakdown[0].present).toBe(false);
    expect(computeBand(mk()).score_breakdown[0].present).toBe(false);
  });
});

describe("deriveOutcome (legacy bridge)", () => {
  it("maps band signals to the coarse outcome label", () => {
    expect(deriveOutcome(mk({ disqualifier: "not_interested" }))).toBe("not_interested");
    expect(deriveOutcome(mk({ callback: true }))).toBe("callback_requested");
    expect(deriveOutcome(mk({ volume: true }))).toBe("interested");
    expect(deriveOutcome(mk())).toBe("unknown");
  });
});
