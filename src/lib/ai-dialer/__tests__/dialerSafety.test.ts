// D1 + B3 — the dialler safety rules: pause on a refusing carrier, two dials a
// day, dialler hours, and a dead number (SIP 404) is the dealer's, not ours.
//
// Instants are written in IST (+05:30); 2026-09-28 is a Monday.

import { describe, expect, it } from "vitest";
import {
    CARRIER_PAUSE_THRESHOLD,
    countDialsOnIstDay,
    isAutoRetryable,
    isLineBlockedFailure,
    MAX_DIALS_PER_DAY,
    nextLineBlockedCount,
    planRetry,
    planRetryDetailed,
    shouldPauseForCarrier,
    withinDialerHours,
    type RetryInput,
    type RetryWindow,
} from "@/lib/ai-dialer/retryPolicy";
import { classifyTriggerDetail } from "@/lib/ai-dialer/failureReason";
import { DIALER_HOURS } from "@/lib/queue/campaignSchedule";

const ist = (s: string) => new Date(`${s}+05:30`);

const WORK: RetryWindow = { start: "09:00", end: "19:00", days: ["mon", "tue", "wed", "thu", "fri", "sat"] };

const base = (over: Partial<RetryInput> = {}): RetryInput => ({
    status: "busy",
    callOutcome: null,
    attemptCount: 1,
    maxRetries: 3,
    now: ist("2026-09-28T11:00:00"),
    window: WORK,
    ...over,
});

const SIP_403 = "trigger_failed: unexpected status from INVITE response: sip status: 403: Forbidden (SIP 403)";
const SIP_486 = "trigger_failed: INVITE failed: sip status: 486: Busy Here";
const SIP_404 = "trigger_failed: INVITE failed: sip status: 404: Not Found";

describe("D1 — carrier refusals in a row", () => {
    it("counts only line-blocked failures; anything that reached the carrier resets", () => {
        let n = 0;
        for (let i = 0; i < 9; i++) n = nextLineBlockedCount(n, SIP_403);
        expect(n).toBe(9);
        expect(shouldPauseForCarrier(n)).toBe(false);
        expect(nextLineBlockedCount(n, SIP_486)).toBe(0); // busy: the network rang the dealer
        expect(nextLineBlockedCount(n, null)).toBe(0); // a placed call
        expect(nextLineBlockedCount(n, SIP_404)).toBe(0); // a dead number is still the carrier answering
    });

    it(`pauses at exactly ${CARRIER_PAUSE_THRESHOLD} in a row`, () => {
        let n = 0;
        for (let i = 0; i < CARRIER_PAUSE_THRESHOLD; i++) n = nextLineBlockedCount(n, SIP_403);
        expect(shouldPauseForCarrier(n - 1)).toBe(false);
        expect(shouldPauseForCarrier(n)).toBe(true);
    });
});

describe("SIP 404 is a dead number, not our line", () => {
    it("classifies as invalid_number, so it is neither line-blocked nor retried", () => {
        expect(classifyTriggerDetail("INVITE failed: sip status: 404: Not Found")).toBe("invalid_number");
        expect(isLineBlockedFailure(SIP_404)).toBe(false);
        expect(isAutoRetryable("failed", SIP_404)).toBe(false);
    });

    it("a provider 'not found' without SIP stays our config error", () => {
        expect(classifyTriggerDetail("Document with id phnum_68 not found.")).toBe("config_error");
    });
});

describe("B3 — dialler hours", () => {
    it("narrows a campaign window to 10:00-19:00", () => {
        expect(DIALER_HOURS).toEqual({ start: "10:00", end: "19:00" });
        expect(withinDialerHours(WORK)).toEqual({ ...WORK, start: "10:00", end: "19:00" });
        expect(withinDialerHours({ start: "11:00", end: "15:00", days: null })).toEqual({
            start: "11:00",
            end: "15:00",
            days: null,
        });
        expect(withinDialerHours({ start: "08:00", end: "21:00", days: null })).toEqual({
            start: "10:00",
            end: "19:00",
            days: null,
        });
    });

    it("an overnight or non-overlapping window falls back to dialler hours", () => {
        expect(withinDialerHours({ start: "22:00", end: "06:00", days: null }).start).toBe("10:00");
        expect(withinDialerHours({ start: "06:00", end: "09:30", days: null }).end).toBe("19:00");
    });

    it("a retry never lands before 10:00", () => {
        expect(planRetry(base({ now: ist("2026-09-28T07:00:00") }))).toEqual(ist("2026-09-28T10:00:00"));
    });
});

describe("B3 — at most two dials a day", () => {
    it(`MAX_DIALS_PER_DAY is ${MAX_DIALS_PER_DAY}`, () => expect(MAX_DIALS_PER_DAY).toBe(2));

    it("the first dial of the day books a same-day retry", () => {
        // busy → 15 min
        expect(planRetry(base({ dialsToday: 1 }))).toEqual(ist("2026-09-28T11:15:00"));
    });

    it("after the second dial today the retry moves to tomorrow's opening", () => {
        expect(planRetry(base({ attemptCount: 2, dialsToday: 2 }))).toEqual(ist("2026-09-29T10:00:00"));
    });

    it("a retry already landing tomorrow is untouched", () => {
        expect(planRetry(base({ attemptCount: 2, dialsToday: 2, now: ist("2026-09-28T18:30:00") }))).toEqual(
            ist("2026-09-29T10:00:00"),
        );
    });

    it("Saturday's spent day skips Sunday", () => {
        expect(planRetry(base({ attemptCount: 2, dialsToday: 2, now: ist("2026-10-03T11:00:00") }))).toEqual(
            ist("2026-10-05T10:00:00"),
        );
    });

    it("a refunded line-blocked dial does not spend the day", () => {
        const plan = planRetryDetailed(base({ status: "failed", callOutcome: SIP_403, dialsToday: 5 }));
        expect(plan).toEqual({ at: ist("2026-09-28T11:30:00"), consumesAttempt: false });
    });

    it("counts only counted dials on today's IST date", () => {
        const now = ist("2026-09-28T11:00:00");
        const history = [
            { at: ist("2026-09-27T18:00:00").toISOString() }, // yesterday
            { at: ist("2026-09-28T00:10:00").toISOString() }, // today, just after IST midnight
            { at: ist("2026-09-28T10:30:00").toISOString(), counted: false }, // refunded
            { at: ist("2026-09-28T10:45:00").toISOString() },
        ];
        expect(countDialsOnIstDay(history, now)).toBe(2);
    });
});

describe("D2 — a switchboard is never redialled", () => {
    it("is not auto-retried, a personal voicemail still is", () => {
        expect(isAutoRetryable("switchboard", null)).toBe(false);
        expect(isAutoRetryable("voicemail", null)).toBe(true);
        expect(planRetry(base({ status: "switchboard" }))).toBeNull();
    });
});
