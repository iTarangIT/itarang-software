import { describe, expect, it } from "vitest";
import {
    DEEP_DISCHARGE_ENTER_PCT,
    DEEP_DISCHARGE_EXIT_PCT,
    MIN_DISCHARGE_SAMPLES,
    MIN_DISCHARGE_SOC_DROP,
    ahPerKm,
    depthOfDischarge,
    dischargeDivergencePct,
    socDerivedAh,
} from "@/lib/telemetry/discharge-math";

describe("socDerivedAh — the primary discharge series", () => {
    it("takes the SOC swing against the nameplate", () => {
        // 100% -> 20% on a 105 Ah pack draws 80% of 105 Ah.
        expect(socDerivedAh(100, 20, 105)).toBe(84);
        expect(socDerivedAh(50, 25, 105)).toBe(26.25);
    });

    it("needs only the two endpoints, so sparse sampling cannot degrade it", () => {
        // This is the whole reason it is the primary series: a 2-sample discharge and a
        // 200-sample discharge over the same SOC swing give the same answer, because SOC is
        // a state, not a rate. The coulomb integral cannot make that claim.
        expect(socDerivedAh(90, 10, 105)).toBe(84);
    });

    it("declines when SOC did not fall, or the nameplate is unknown", () => {
        expect(socDerivedAh(20, 20, 105)).toBeNull();
        expect(socDerivedAh(20, 80, 105)).toBeNull(); // that is a charge
        expect(socDerivedAh(100, 20, null)).toBeNull();
        expect(socDerivedAh(100, 20, 0)).toBeNull();
        expect(socDerivedAh(null, 20, 105)).toBeNull();
    });
});

describe("depthOfDischarge", () => {
    it("is the SOC swing, and only when it fell", () => {
        expect(depthOfDischarge(100, 20)).toBe(80);
        expect(depthOfDischarge(20, 100)).toBeNull();
        expect(depthOfDischarge(50, 50)).toBeNull();
    });
});

describe("dischargeDivergencePct — the confidence signal", () => {
    it("reports how far the coulomb integral has drifted from the SOC-derived figure", () => {
        expect(dischargeDivergencePct(100, 120)).toBe(20);
        expect(dischargeDivergencePct(100, 80)).toBe(-20);
        expect(dischargeDivergencePct(84, 84)).toBe(0);
    });

    it("declines rather than dividing by nothing", () => {
        expect(dischargeDivergencePct(0, 50)).toBeNull();
        expect(dischargeDivergencePct(null, 50)).toBeNull();
        expect(dischargeDivergencePct(50, null)).toBeNull();
    });
});

describe("ahPerKm", () => {
    it("is the efficiency number the discharge-vs-distance scatter exists to expose", () => {
        expect(ahPerKm(84, 100)).toBe(0.84);
        expect(ahPerKm(50, 40)).toBe(1.25);
    });

    it("declines on a day with no distance, rather than reporting infinity", () => {
        expect(ahPerKm(84, 0)).toBeNull();
        expect(ahPerKm(84, null)).toBeNull();
        expect(ahPerKm(null, 100)).toBeNull();
    });
});

describe("gates", () => {
    it("keeps the sample floor away from detection", () => {
        // The charge side put a sample floor in its detection gate and lost 70% of real
        // charges to it. MIN_DISCHARGE_SAMPLES exists to gate the COULOMB integral only —
        // never whether a discharge happened. socDerivedAh needs two endpoints, not five.
        expect(MIN_DISCHARGE_SAMPLES).toBe(5);
        expect(socDerivedAh(100, 20, 105)).toBe(84); // 2-sample discharge still measurable
    });

    it("debounces deep discharge with a hysteresis band, not a bare threshold", () => {
        expect(DEEP_DISCHARGE_ENTER_PCT).toBe(20);
        expect(DEEP_DISCHARGE_EXIT_PCT).toBe(25);
        expect(DEEP_DISCHARGE_EXIT_PCT).toBeGreaterThan(DEEP_DISCHARGE_ENTER_PCT);
    });

    it("does not report a 1% bleed as a discharge", () => {
        expect(MIN_DISCHARGE_SOC_DROP).toBe(5);
    });
});

/**
 * The Schmitt trigger, as a pure state machine over an SOC series.
 *
 * Mirrors deepDischargeCTEs' dd_marked → dd_state → dd_islands chain so its behaviour can be
 * pinned without a database. If this and the SQL ever disagree, the SQL is what ships — but
 * this is what makes the intent testable.
 */
function deepDischargeEvents(soc: number[]): Array<{ from: number; to: number; minSoc: number }> {
    const events: Array<{ from: number; to: number; minSoc: number }> = [];
    let state: 0 | 1 | null = null;
    let start = -1;
    let minSoc = 100;

    soc.forEach((s, i) => {
        const mark: 0 | 1 | null =
            s < DEEP_DISCHARGE_ENTER_PCT ? 1 : s >= DEEP_DISCHARGE_EXIT_PCT ? 0 : null;
        const next = mark ?? state; // carry the state through the hysteresis band
        if (next === 1 && state !== 1) {
            start = i;
            minSoc = s;
        } else if (next === 1) {
            minSoc = Math.min(minSoc, s);
        } else if (next === 0 && state === 1) {
            events.push({ from: start, to: i - 1, minSoc });
        }
        state = next;
    });
    if (state === 1) events.push({ from: start, to: soc.length - 1, minSoc });
    return events;
}

describe("deep discharge — the Schmitt trigger", () => {
    it("counts one long low-SOC stretch as ONE event", () => {
        // A battery sitting at 12% for two days is one event, not one per sample.
        const events = deepDischargeEvents([40, 30, 12, 12, 12, 12, 12, 12, 40]);
        expect(events).toHaveLength(1);
        expect(events[0].minSoc).toBe(12);
    });

    it("does not count a battery bouncing across the threshold as many events", () => {
        // 19 -> 21 -> 19 -> 21 is ONE event: 21 is inside the hysteresis band (20..25), so it
        // does not clear the trigger. A bare `SOC < 20` test would report four.
        const events = deepDischargeEvents([40, 19, 21, 19, 21, 19, 21, 40]);
        expect(events).toHaveLength(1);
    });

    it("counts a genuine recovery and a re-entry as TWO events", () => {
        // Recovering to 30 clears the 25% exit threshold, so the next dip is a new event.
        const events = deepDischargeEvents([40, 15, 15, 30, 40, 12, 12, 40]);
        expect(events).toHaveLength(2);
        expect(events[0].minSoc).toBe(15);
        expect(events[1].minSoc).toBe(12);
    });

    it("does not fire while SOC merely sits inside the hysteresis band", () => {
        // 22% is below the exit threshold but never below the enter threshold. Nothing
        // happened; carrying an undefined state into an event would invent one.
        expect(deepDischargeEvents([40, 22, 22, 22, 40])).toHaveLength(0);
    });

    it("has no state until the first decisive sample", () => {
        // A series that opens inside the band has no prior state to carry, and guessing one
        // would fabricate an event out of an unknown.
        expect(deepDischargeEvents([22, 22, 30])).toHaveLength(0);
    });

    it("leaves an event open when the window ends inside it", () => {
        const events = deepDischargeEvents([40, 10, 10]);
        expect(events).toHaveLength(1);
        expect(events[0].to).toBe(2);
    });
});
