import { describe, it, expect } from "vitest";
import { computeIntentScore } from "../computeIntentScore";
import { deriveOutcome } from "../legacyAnalysis";
import { decideRoute } from "../thresholds";
import { mk } from "./_fixtures";

// Exact-score assertions over fixed signal inputs. These pin production
// behaviour: any change to weights/caps must update these on purpose, never
// silently. Expected values are hand-computed from weights.ts.
describe("computeIntentScore — exact scores", () => {
  it("strong-buy → 100, qualified", () => {
    const r = computeIntentScore(
      mk({
        need: "strong",
        budget: "strong",
        engagement: "strong",
        curiosity: "strong",
        timeline: "now",
        objection: "substantive",
        authority: "decision_maker",
      }),
    );
    expect(r.intent_score).toBe(100); // 30+25+15+12+10+8
    expect(r.qualified_gate).toBe(true);
  });

  it("callback-only brush-off (the Mishra case) → ~7, NOT 60", () => {
    const signals = mk({ engagement: "weak", timeline: "later", callback: true });
    const r = computeIntentScore(signals);
    expect(r.intent_score).toBe(7); // engagement weak(5) + timeline later(2)
    expect(r.qualified_gate).toBe(false);
    expect(deriveOutcome(signals)).toBe("callback_requested");
    // Business override still schedules the callback, decoupled from the number.
    expect(decideRoute(r.intent_score, signals, r.qualified_gate)).toEqual({
      status: "warm",
      action: "schedule_call",
    });
  });

  it("quantity-only → 47, interested, warm", () => {
    const signals = mk({
      need: "moderate",
      budget: "weak",
      engagement: "moderate",
      curiosity: "moderate",
      quantity: "20 units",
    });
    const r = computeIntentScore(signals);
    expect(r.intent_score).toBe(47); // 20+9+10+8
    expect(deriveOutcome(signals)).toBe("interested");
    expect(decideRoute(r.intent_score, signals, r.qualified_gate).status).toBe("warm");
  });

  it("quantity + callback → 49, callback route", () => {
    const signals = mk({
      need: "moderate",
      budget: "weak",
      engagement: "moderate",
      curiosity: "moderate",
      timeline: "later",
      quantity: "20 units",
      callback: true,
    });
    const r = computeIntentScore(signals);
    expect(r.intent_score).toBe(49); // 20+9+10+8+2
    expect(deriveOutcome(signals)).toBe("callback_requested");
    expect(decideRoute(r.intent_score, signals, r.qualified_gate).action).toBe("schedule_call");
  });

  it("flat rejection → 0 and routes to stop", () => {
    const signals = mk({ not_interested: true });
    const r = computeIntentScore(signals);
    expect(r.intent_score).toBe(0);
    expect(r.qualified_gate).toBe(false);
    expect(decideRoute(r.intent_score, signals, r.qualified_gate)).toEqual({
      status: "disqualified",
      action: "stop",
    });
  });

  it("competitor-bought caps a strong call at 10 and routes to stop", () => {
    const signals = mk({
      need: "strong",
      budget: "strong",
      engagement: "strong",
      curiosity: "strong",
      timeline: "now",
      objection: "substantive",
      competitor_bought: true,
    });
    const r = computeIntentScore(signals);
    expect(r.intent_score).toBe(10); // positives 100 capped to 10
    expect(r.qualified_gate).toBe(false);
    expect(r.score_breakdown.some((c) => c.signal === "cap:already_bought_competitor")).toBe(true);
    expect(decideRoute(r.intent_score, signals, r.qualified_gate).action).toBe("stop");
  });

  it("garbled / all-unknown → 0, not qualified", () => {
    const r = computeIntentScore(mk());
    expect(r.intent_score).toBe(0);
    expect(r.qualified_gate).toBe(false);
  });

  it("authority absent blocks 'qualified' even at 100 → warm/schedule", () => {
    const signals = mk({
      need: "strong",
      budget: "strong",
      engagement: "strong",
      curiosity: "strong",
      timeline: "now",
      objection: "substantive",
      authority: "not_decision_maker",
    });
    const r = computeIntentScore(signals);
    expect(r.intent_score).toBe(100);
    expect(r.qualified_gate).toBe(false); // gate, separate from the number
    expect(decideRoute(r.intent_score, signals, r.qualified_gate)).toEqual({
      status: "warm",
      action: "schedule_call",
    });
  });

  it("timeline 'later' reduces but does not zero", () => {
    const base = {
      need: "strong" as const,
      budget: "strong" as const,
      engagement: "strong" as const,
      curiosity: "strong" as const,
      objection: "substantive" as const,
    };
    const later = computeIntentScore(mk({ ...base, timeline: "later" }));
    const none = computeIntentScore(mk({ ...base, timeline: "none" }));
    expect(later.intent_score).toBe(92); // 90 positives + later(2)
    expect(none.intent_score).toBe(90);
    expect(later.intent_score).toBeGreaterThan(none.intent_score);
  });
});
