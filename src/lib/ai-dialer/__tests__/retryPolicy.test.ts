// Tests for the E-315 campaign auto-retry policy.
//
// All instants are written in IST (+05:30) because that is how operators read
// them; 2026-09-28 is a Monday, 2026-10-04 a Sunday.

import { describe, expect, it } from "vitest";
import {
    clampIntoWindow,
    isAutoRetryable,
    isLineBlockedFailure,
    MAX_LINE_BLOCKED_RETRIES,
    planRetryDetailed,
    isWindowOpen,
    nextWindowOpen,
    planRetry,
    type RetryInput,
    type RetryWindow,
} from "@/lib/ai-dialer/retryPolicy";

const ist = (s: string) => new Date(`${s}+05:30`);

const WORK: RetryWindow = {
    start: "09:00",
    end: "19:00",
    days: ["mon", "tue", "wed", "thu", "fri", "sat"],
};

const base = (over: Partial<RetryInput> = {}): RetryInput => ({
    status: "no_response",
    callOutcome: null,
    attemptCount: 1,
    maxRetries: 3,
    now: ist("2026-09-28T11:00:00"),
    window: WORK,
    ...over,
});

describe("isAutoRetryable", () => {
    it.each(["busy", "no_response", "rejected", "voicemail", "silent", "hung_up", "no_conversation"])(
        "retries %s",
        (status) => expect(isAutoRetryable(status, null)).toBe(true),
    );

    it.each(["completed", "skipped", "pending", "calling"])("never retries %s", (status) =>
        expect(isAutoRetryable(status, null)).toBe(false),
    );

    it("retries a no_webhook failure", () => {
        expect(isAutoRetryable("failed", "no_webhook")).toBe(true);
    });

    it("never retries an invalid number, even under a retryable status", () => {
        expect(isAutoRetryable("failed", "invalid_number")).toBe(false);
        expect(isAutoRetryable("no_response", "invalid_number: number does not exist")).toBe(false);
    });

    it("never retries a row the user stopped", () => {
        expect(isAutoRetryable("failed", "stopped_by_user")).toBe(false);
    });
});

describe("planRetry — attempt budget", () => {
    it("is off when max_retries is null (pre-E-315 campaigns)", () => {
        expect(planRetry(base({ maxRetries: null }))).toBeNull();
    });

    it("allows 1 + max_retries dials in total", () => {
        expect(planRetry(base({ attemptCount: 3 }))).not.toBeNull();
        expect(planRetry(base({ attemptCount: 4 }))).toBeNull();
    });

    it("does not retry a completed call", () => {
        expect(planRetry(base({ status: "completed" }))).toBeNull();
    });
});

describe("planRetry — gaps", () => {
    it("busy: 15 min, 1 h, 3 h", () => {
        const now = ist("2026-09-28T11:00:00");
        expect(planRetry(base({ status: "busy", attemptCount: 1, now }))).toEqual(ist("2026-09-28T11:15:00"));
        expect(planRetry(base({ status: "busy", attemptCount: 2, now }))).toEqual(ist("2026-09-28T12:00:00"));
        expect(planRetry(base({ status: "busy", attemptCount: 3, now }))).toEqual(ist("2026-09-28T14:00:00"));
    });

    it("others: 1 h, 3 h, next day at window start", () => {
        const now = ist("2026-09-28T11:00:00");
        expect(planRetry(base({ attemptCount: 1, now }))).toEqual(ist("2026-09-28T12:00:00"));
        expect(planRetry(base({ attemptCount: 2, now }))).toEqual(ist("2026-09-28T14:00:00"));
        expect(planRetry(base({ attemptCount: 3, now }))).toEqual(ist("2026-09-29T09:00:00"));
    });
});

describe("planRetry — calling hours", () => {
    it("moves an evening retry to 09:00 the next day", () => {
        expect(planRetry(base({ now: ist("2026-09-28T18:30:00") }))).toEqual(ist("2026-09-29T09:00:00"));
    });

    it("skips Sunday", () => {
        // Saturday 18:30 + 1 h → Saturday 19:30 (shut) → Monday 09:00
        expect(planRetry(base({ now: ist("2026-10-03T18:30:00") }))).toEqual(ist("2026-10-05T09:00:00"));
    });

    it("an early-morning result waits for the window to open the same day", () => {
        expect(planRetry(base({ status: "busy", now: ist("2026-09-28T07:00:00") }))).toEqual(
            ist("2026-09-28T09:00:00"),
        );
    });
});

describe("line blocked on our side (refunded attempts)", () => {
    // Real prod outcome, 2026-09-30.
    const SIP_403 =
        "trigger_failed: unexpected status from INVITE response: sip status: 403: Forbidden (SIP 403)";
    const SIP_429 =
        "trigger_failed: unexpected status from INVITE response: sip status: 429 (PROVIDE_REFERRER_IDENTITY)";

    it("recognises 403 / 429 / config errors, not dealer-side SIP codes", () => {
        expect(isLineBlockedFailure(SIP_403)).toBe(true);
        expect(isLineBlockedFailure(SIP_429)).toBe(true);
        expect(isLineBlockedFailure("trigger_failed: invalid from_number")).toBe(true);
        expect(isLineBlockedFailure("trigger_failed: INVITE failed: sip status: 486 Busy Here")).toBe(false);
        expect(isLineBlockedFailure("trigger_failed: INVITE failed: sip status: 480")).toBe(false);
        expect(isLineBlockedFailure("no_webhook")).toBe(false);
        expect(isLineBlockedFailure(null)).toBe(false);
    });

    it("a phone number containing 403 is not a SIP 403", () => {
        expect(isLineBlockedFailure("trigger_failed: sip status: 480 for +919840312345")).toBe(false);
    });

    it("refunds the dial and waits 30 min, even on the last attempt", () => {
        const plan = planRetryDetailed(
            base({ status: "failed", callOutcome: SIP_403, attemptCount: 4, now: ist("2026-09-30T14:00:00") }),
        );
        expect(plan).toEqual({ at: ist("2026-09-30T14:30:00"), consumesAttempt: false });
    });

    it("the 30-min pause still respects calling hours", () => {
        const plan = planRetryDetailed(
            base({ status: "failed", callOutcome: SIP_403, now: ist("2026-09-30T18:45:00") }),
        );
        expect(plan?.at).toEqual(ist("2026-10-01T09:00:00"));
    });

    it("after MAX_LINE_BLOCKED_RETRIES the dial counts like any failure", () => {
        const plan = planRetryDetailed(
            base({
                status: "failed",
                callOutcome: SIP_403,
                attemptCount: 4,
                lineBlockedRetriesUsed: MAX_LINE_BLOCKED_RETRIES,
            }),
        );
        expect(plan).toBeNull(); // 4th dial, budget spent
    });

    it("is off for campaigns without auto-retry", () => {
        expect(planRetryDetailed(base({ status: "failed", callOutcome: SIP_403, maxRetries: null }))).toBeNull();
    });

    it("a normal outcome consumes the attempt", () => {
        expect(planRetryDetailed(base())?.consumesAttempt).toBe(true);
    });
});

describe("window helpers", () => {
    const NIGHT: RetryWindow = { start: "22:00", end: "06:00", days: null };

    it("handles an overnight window", () => {
        expect(isWindowOpen(ist("2026-09-28T23:00:00"), NIGHT)).toBe(true);
        expect(isWindowOpen(ist("2026-09-28T05:59:00"), NIGHT)).toBe(true);
        expect(isWindowOpen(ist("2026-09-28T06:00:00"), NIGHT)).toBe(false);
        expect(clampIntoWindow(ist("2026-09-28T12:00:00"), NIGHT)).toEqual(ist("2026-09-28T22:00:00"));
    });

    it("nextWindowOpen is strictly after now", () => {
        expect(nextWindowOpen(ist("2026-09-28T09:00:00"), WORK)).toEqual(ist("2026-09-29T09:00:00"));
    });

    it("a Monday-only window resolves next Monday", () => {
        const mon: RetryWindow = { ...WORK, days: ["mon"] };
        expect(nextWindowOpen(ist("2026-09-28T10:00:00"), mon)).toEqual(ist("2026-10-05T09:00:00"));
    });
});
