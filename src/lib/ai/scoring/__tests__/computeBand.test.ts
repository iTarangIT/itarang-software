import { describe, it, expect } from "vitest";
import { computeBand, INFO_SIGNALS_QUALIFY_THRESHOLD } from "../computeBand";
import { deriveOutcome } from "../legacyAnalysis";
import { mk } from "./_fixtures";

// The band rule (docs/intent_docs/intent_score.pdf §3). Top rule wins. These
// pin production behaviour — any change to the rule must update these on purpose.
describe("computeBand — the band rule (top rule wins)", () => {
  it("substance path: ≥3 info signals → Qualified (90/hot/push_to_crm)", () => {
    const r = computeBand(mk({ spec: true, volume: true, need: true }));
    expect(r.band).toBe("Qualified");
    expect(r.info_signals_count).toBe(3);
    expect(r.lead_score).toBe(90);
    expect(r.interest_level).toBe("hot");
    expect(r.action).toBe("push_to_crm");
    expect(r.call_status).toBe("complete");
    expect(r.hard_negative).toBe(false);
  });

  it("commitment path: passive callback with zero info → Qualified", () => {
    const r = computeBand(mk({ callback: true }));
    expect(r.band).toBe("Qualified");
    expect(r.info_signals_count).toBe(0);
    expect(r.lead_score).toBe(90);
  });

  it("1–2 info signals, no callback → Warm (60/warm/schedule_call)", () => {
    const one = computeBand(mk({ volume: true }));
    expect(one.band).toBe("Warm");
    expect(one.info_signals_count).toBe(1);
    expect(one.lead_score).toBe(60);
    expect(one.interest_level).toBe("warm");
    expect(one.action).toBe("schedule_call");

    const two = computeBand(mk({ spec: true, volume: true }));
    expect(two.band).toBe("Warm");
    expect(two.info_signals_count).toBe(2);
  });

  it("pitch heard, nothing disclosed → Cold (30/cold/follow_up)", () => {
    const r = computeBand(mk({ pitch: true }));
    expect(r.band).toBe("Cold");
    expect(r.info_signals_count).toBe(0);
    expect(r.lead_score).toBe(30);
    expect(r.interest_level).toBe("cold");
    expect(r.action).toBe("follow_up");
  });

  it("relevant_dealer=no → Disqualified, OVERRIDING callback + substance", () => {
    const r = computeBand(
      mk({ relevant: false, callback: true, spec: true, volume: true, need: true }),
    );
    expect(r.band).toBe("Disqualified");
    expect(r.lead_score).toBe(0);
    expect(r.interest_level).toBe(null);
    expect(r.action).toBe("stop");
    expect(r.hard_negative).toBe(true);
  });

  it("hard disqualifier beats callback AND substance", () => {
    for (const d of ["dont_call", "hostile", "not_interested"] as const) {
      const r = computeBand(
        mk({ disqualifier: d, callback: true, spec: true, volume: true, need: true }),
      );
      expect(r.band).toBe("Disqualified");
      expect(r.hard_negative).toBe(true);
      expect(r.action).toBe("stop");
    }
  });
});

describe("computeBand — dropped calls", () => {
  it("dropped_empty: call_dropped + 0 info + no callback → no band, auto_retry", () => {
    const r = computeBand(mk({ relevant: false, disqualifier: "call_dropped" }));
    expect(r.band).toBe(null);
    expect(r.call_status).toBe("dropped_empty");
    expect(r.action).toBe("auto_retry");
    expect(r.lead_score).toBe(0);
    expect(r.hard_negative).toBe(false); // untouched, not demoted
  });

  it("dropped_partial: substance captured before the drop → banded normally", () => {
    const r = computeBand(
      mk({ disqualifier: "call_dropped", spec: true, volume: true, need: true }),
    );
    expect(r.call_status).toBe("dropped_partial");
    expect(r.band).toBe("Qualified");
    expect(r.info_signals_count).toBe(3);
  });

  it("dropped_partial via callback alone (0 info) → Qualified", () => {
    const r = computeBand(mk({ disqualifier: "call_dropped", callback: true }));
    expect(r.call_status).toBe("dropped_partial");
    expect(r.band).toBe("Qualified");
  });

  it("dropped + 1 info, no callback → dropped_partial Warm (not voided)", () => {
    const r = computeBand(mk({ disqualifier: "call_dropped", volume: true }));
    expect(r.call_status).toBe("dropped_partial");
    expect(r.band).toBe("Warm");
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
    // pitch/callback/relevant are NOT info signals.
    expect(
      computeBand(mk({ pitch: true, callback: true, relevant: true })).info_signals_count,
    ).toBe(0);
  });

  it("breakdown carries one row per info signal flagged info, with present", () => {
    const r = computeBand(mk({ spec: true, volume: false }));
    const infoRows = r.score_breakdown.filter((l) => l.info);
    expect(infoRows).toHaveLength(5);
    expect(infoRows.find((l) => l.signal === "battery_spec_shared")?.present).toBe(true);
    expect(infoRows.find((l) => l.signal === "volume_shared")?.present).toBe(false);
  });

  it("the qualify threshold is 3", () => {
    expect(INFO_SIGNALS_QUALIFY_THRESHOLD).toBe(3);
    expect(computeBand(mk({ spec: true, volume: true })).band).toBe("Warm"); // 2
    expect(computeBand(mk({ spec: true, volume: true, need: true })).band).toBe(
      "Qualified",
    ); // 3
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
