import { describe, expect, it } from "vitest";
import {
    nextDayInWindow,
    nextHalfWindow,
    planReattempt,
    planRetryDetailed,
    REATTEMPT_RULES,
    type RetryInput,
} from "../retryPolicy";
import {
    ALL_CONNECTED_DISPOSITIONS,
    NOT_CONNECTED_REASONS,
    RETIRED_DISPOSITIONS,
} from "@/lib/leads/dispositions";

// 5 Nov 2026 is a Thursday. IST = UTC + 5:30.
const ist = (day: number, hh: number, mm = 0) =>
    new Date(Date.UTC(2026, 10, day, hh, mm) - 330 * 60_000);
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
const everyDay = { start: "09:00", end: "19:00", days: null };
const monSat = { start: "09:00", end: "19:00", days: ["mon", "tue", "wed", "thu", "fri", "sat"] };

function plan(disposition: string, extra: Partial<RetryInput> = {}) {
    return planReattempt({
        status: "failed",
        callOutcome: null,
        attemptCount: 1,
        maxRetries: 5,
        now: ist(5, 10, 30),
        window: everyDay,
        dialsToday: 1,
        disposition,
        ...extra,
    });
}

describe("REATTEMPT_RULES covers the sheet", () => {
    it("every connected label and every not-connected reason has a rule", () => {
        for (const label of [...ALL_CONNECTED_DISPOSITIONS, ...NOT_CONNECTED_REASONS]) {
            if (["Pitch Heard, No Response", "Details Shared, Not Qualified", "Callback Agreed", "AI Qualified"].includes(label)) continue;
            expect(REATTEMPT_RULES[label], label).toBeDefined();
        }
        for (const label of RETIRED_DISPOSITIONS) expect(REATTEMPT_RULES[label], label).toBeDefined();
    });
});

describe("half-day windows", () => {
    it("next window: morning → 14:00 today; afternoon → tomorrow's opening; before opening → opening", () => {
        expect(iso(nextHalfWindow(ist(5, 10, 30), everyDay))).toBe(iso(ist(5, 14)));
        expect(iso(nextHalfWindow(ist(5, 14, 0), everyDay))).toBe(iso(ist(6, 10)));
        expect(iso(nextHalfWindow(ist(5, 8, 0), everyDay))).toBe(iso(ist(5, 10)));
        expect(iso(nextHalfWindow(ist(5, 22, 0), everyDay))).toBe(iso(ist(6, 10)));
    });

    it("next day keeps the offset into the half; 'other' flips the half", () => {
        expect(iso(nextDayInWindow(ist(5, 10, 30), everyDay, "same"))).toBe(iso(ist(6, 10, 30)));
        expect(iso(nextDayInWindow(ist(5, 10, 30), everyDay, "other"))).toBe(iso(ist(6, 14, 30)));
        expect(iso(nextDayInWindow(ist(5, 15, 0), everyDay, "other"))).toBe(iso(ist(6, 11, 0)));
    });

    it("an offset longer than the target half is clamped inside it", () => {
        // 18:59 is 299 min into the afternoon; the morning half is only 240 min.
        const at = nextDayInWindow(ist(5, 18, 59), everyDay, "other")!;
        expect(at.getTime()).toBeGreaterThanOrEqual(ist(6, 10).getTime());
        expect(at.getTime()).toBeLessThan(ist(6, 14).getTime());
    });

    it("skips a closed day (Saturday dial → Monday under Mon–Sat)", () => {
        expect(iso(nextDayInWindow(ist(7, 11, 0), monSat, "same"))).toBe(iso(ist(9, 11, 0)));
        expect(iso(nextHalfWindow(ist(7, 15, 0), monSat))).toBe(iso(ist(9, 10)));
    });
});

describe("planReattempt — sheet rules", () => {
    it("Busy: after 30 min", () => {
        expect(iso(plan("Busy in another call")?.at)).toBe(iso(ist(5, 11, 0)));
    });

    it("Busy: a third dial today waits for tomorrow's opening", () => {
        expect(iso(plan("Busy in another call", { dialsToday: 2 })?.at)).toBe(iso(ist(6, 10)));
    });

    it("Busy at 18:45: +30 min is outside hours → tomorrow's opening", () => {
        expect(iso(plan("Busy in another call", { now: ist(5, 18, 45) })?.at)).toBe(iso(ist(6, 10)));
    });

    it("Did not pick: next window, at most 2 a day, for 3 days", () => {
        expect(iso(plan("Did not pick")?.at)).toBe(iso(ist(5, 14)));
        expect(iso(plan("Did not pick", { now: ist(5, 15), dialsToday: 2 })?.at)).toBe(iso(ist(6, 10)));
        const history = [{ at: ist(5, 10).toISOString() }, { at: ist(5, 15).toISOString() }];
        // Day 3 afternoon → next window is day 4: past the 3-day limit.
        expect(plan("Did not pick", { now: ist(7, 15), history, attemptCount: 5 })).toBeNull();
        // Day 3 morning → day 3 afternoon is still inside.
        expect(iso(plan("Did not pick", { now: ist(7, 10, 30), history, attemptCount: 4 })?.at)).toBe(iso(ist(7, 14)));
    });

    it("Dropped mid-call: redial within 15 min, once", () => {
        expect(iso(plan("Dropped mid-call")?.at)).toBe(iso(ist(5, 10, 45)));
        expect(plan("Dropped mid-call", { history: [{ at: ist(5, 10).toISOString(), disp: "Dropped mid-call" }] })).toBeNull();
    });

    it("Dead audio: 15 min, then next day, then done", () => {
        expect(iso(plan("Dead audio (no sound either way)")?.at)).toBe(iso(ist(5, 10, 45)));
        const once = [{ at: ist(5, 10).toISOString(), disp: "Dead audio (no sound either way)" }];
        expect(iso(plan("Dead audio (no sound either way)", { history: once })?.at)).toBe(iso(ist(6, 10, 30)));
        const twice = [...once, { at: ist(5, 10, 15).toISOString(), disp: "Dead audio (no sound either way)" }];
        expect(plan("Dead audio (no sound either way)", { history: twice })).toBeNull();
    });

    it("Voicemail: next day, one more try only", () => {
        expect(iso(plan("Recording / voicemail")?.at)).toBe(iso(ist(6, 10, 30)));
        expect(plan("Recording / voicemail", { history: [{ disp: "Recording / voicemail", at: ist(4, 10).toISOString() }] })).toBeNull();
    });

    it("Hung up during intro / User disconnected: next day, the other window", () => {
        expect(iso(plan("Hung up during intro")?.at)).toBe(iso(ist(6, 14, 30)));
        expect(iso(plan("User disconnected the call", { now: ist(5, 16) })?.at)).toBe(iso(ist(6, 12)));
    });

    it("Out of coverage: after 2 hours", () => {
        expect(iso(plan("Out of Coverage area / Network issue")?.at)).toBe(iso(ist(5, 12, 30)));
    });

    it("Ask to Call Back: at the time asked (clamped into hours); none or past → next day, same window", () => {
        expect(iso(plan("Ask to Call Back", { requestedAt: ist(5, 17) })?.at)).toBe(iso(ist(5, 17)));
        expect(iso(plan("Ask to Call Back", { requestedAt: ist(5, 21) })?.at)).toBe(iso(ist(6, 10)));
        expect(iso(plan("Ask to Call Back", { requestedAt: ist(5, 9) })?.at)).toBe(iso(ist(6, 10, 30)));
        expect(iso(plan("Ask to Call Back")?.at)).toBe(iso(ist(6, 10, 30)));
    });

    it("Long horizon: 7 / 30 / 90 days, outside the campaign budget", () => {
        const p = plan("Need Some Time", { attemptCount: 9, maxRetries: 0 });
        expect(p?.longHorizon).toEqual({ once: false });
        expect(iso(p?.at)).toBe(iso(ist(12, 10, 30)));
        expect(iso(plan("No requirement in current")?.at)).toBe(iso(ist(5 + 30, 10, 30)));
        expect(plan("Not Interested")?.longHorizon).toEqual({ once: true });
    });

    it("Not Interested a second time: no more redials", () => {
        expect(plan("Not Interested", { history: [{ disp: "Not Interested", at: ist(1, 10).toISOString() }] })).toBeNull();
    });

    it("rules that hand the lead to a person, or retire the number, never redial", () => {
        for (const label of [
            "IVR / auto-attendant",
            "Tracking number, no voice",
            "Information Collected",
            "Bad Experience with Trontek",
            "Loan Procedure Issue",
            "REJECTED BY US",
            "Some other Business",
            "Incorrect / Invalid number",
            "Number not in use / does not exist / out of service",
        ]) {
            expect(plan(label), label).toBeNull();
        }
    });

    it("the campaign budget still caps in-campaign redials", () => {
        expect(plan("Busy in another call", { attemptCount: 6, maxRetries: 5 })).toBeNull();
        expect(plan("Busy in another call", { maxRetries: null })).toBeNull();
        expect(plan("Busy in another call", { maxRetries: 0 })).toBeNull();
    });

    it("a refused attempt (counted: false) does not use up a 'once' rule", () => {
        const history = [{ disp: "Dropped mid-call", counted: false, at: ist(5, 10).toISOString() }];
        expect(plan("Dropped mid-call", { history })).not.toBeNull();
    });
});

describe("planRetryDetailed — how v3 and the old policy meet", () => {
    const base: RetryInput = {
        status: "busy",
        callOutcome: "trigger_failed: sip status: 486",
        attemptCount: 1,
        maxRetries: 3,
        now: ist(5, 10, 30),
        window: everyDay,
        dialsToday: 1,
    };

    it("with a v3 disposition the sheet rule decides", () => {
        expect(iso(planRetryDetailed({ ...base, disposition: "Busy in another call" })?.at)).toBe(iso(ist(5, 11)));
    });

    it("without one the E-315 gaps still apply (15 min for a first busy)", () => {
        expect(iso(planRetryDetailed(base)?.at)).toBe(iso(ist(5, 10, 45)));
    });

    it("an unknown label falls back to the old policy", () => {
        expect(iso(planRetryDetailed({ ...base, disposition: "Something new" })?.at)).toBe(iso(ist(5, 10, 45)));
    });

    it("a carrier refusal is still refunded first, whatever the disposition", () => {
        const p = planRetryDetailed({
            ...base,
            status: "failed",
            callOutcome: "trigger_failed: sip status: 403 Forbidden",
            disposition: "Call not connected / can not be completed",
        });
        expect(p?.consumesAttempt).toBe(false);
    });
});
