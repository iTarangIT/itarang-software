// Tests for the E-315 campaign auto-retry policy.
//
// All instants are written in IST (+05:30) because that is how operators read
// them; 2026-09-28 is a Monday, 2026-10-04 a Sunday.

import { describe, expect, it } from "vitest";
import {
    clampIntoWindow,
    DEFAULT_MAX_RETRIES,
    DISCONNECTED_OUTCOME,
    isAutoRetryable,
    isLineBlockedFailure,
    MAX_LINE_BLOCKED_RETRIES,
    planRetryDetailed,
    isWindowOpen,
    lastConversation,
    nextWindowOpen,
    planRetry,
    REATTEMPT_RULES,
    UNREACHED_RETRY_DAYS,
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

    // 13 Nov 2026 — "call every lead except completed and wrong number".
    it.each([
        ["failed", "stopped_by_user"],
        ["failed", "trigger_failed: sip status: 500"],
        ["failed", null],
    ])("retries %s / %s", (status, outcome) => {
        expect(isAutoRetryable(status, outcome)).toBe(true);
    });

    it("never retries a switchboard / IVR (AI dialer list item 2)", () => {
        expect(isAutoRetryable("switchboard", null)).toBe(false);
        expect(REATTEMPT_RULES["IVR / auto-attendant"]).toEqual({ kind: "none" });
        expect(REATTEMPT_RULES["Tracking number, no voice"]).toEqual({ kind: "none" });
    });

    it("never retries a wrong number sent as SIP 404, or a lead never dialable", () => {
        expect(isAutoRetryable("failed", "trigger_failed: INVITE failed: sip status: 404: Not Found")).toBe(false);
        expect(isAutoRetryable("failed", "no_phone")).toBe(false);
        expect(isAutoRetryable("failed", "ineligible_active_lead")).toBe(false);
    });
});

describe("planRetry — attempt budget", () => {
    // 20 Nov 2026 — an unreached lead is redialled for UNREACHED_RETRY_DAYS,
    // not 1 + max_retries dials.
    it("keeps redialling an unreached lead past max_retries", () => {
        expect(planRetry(base({ maxRetries: null }))).not.toBeNull();
        expect(planRetry(base({ maxRetries: null, attemptCount: DEFAULT_MAX_RETRIES + 1 }))).not.toBeNull();
        expect(planRetry(base({ attemptCount: 4 }))).not.toBeNull();
        expect(planRetry(base({ attemptCount: 12 }))).not.toBeNull();
    });

    it("is off only when max_retries is explicitly 0", () => {
        expect(planRetry(base({ maxRetries: 0 }))).toBeNull();
    });

    it("max_retries still caps redials of a dropped conversation", () => {
        const dropped = { status: "completed", callOutcome: DISCONNECTED_OUTCOME };
        expect(planRetry(base({ ...dropped, attemptCount: 3 }))).not.toBeNull();
        expect(planRetry(base({ ...dropped, attemptCount: 4 }))).toBeNull();
    });

    it(`stops an unreached lead after ${UNREACHED_RETRY_DAYS} days from its first dial`, () => {
        const history = [{ at: ist("2026-09-28T10:00:00").toISOString() }];
        // Day 4 (Fri 2 Oct), dial 11: next opening is Sat 3 Oct = day 5, booked.
        expect(
            planRetry(base({ attemptCount: 11, history, now: ist("2026-10-02T11:00:00") })),
        ).not.toBeNull();
        // Day 7 (Sun 4 Oct, not a working day) would land on Mon 5 Oct = day 7: done.
        expect(
            planRetry(base({ attemptCount: 13, history, dialsToday: 2, now: ist("2026-10-03T17:00:00") })),
        ).toBeNull();
    });

    it("does not retry a completed call", () => {
        expect(planRetry(base({ status: "completed" }))).toBeNull();
        expect(planRetry(base({ status: "completed", callOutcome: "callback_requested" }))).toBeNull();
    });

    // AI dialer review point 8 — cut off mid-conversation.
    it("retries a conversation cut off mid-call, like a hang-up, within the same budget", () => {
        expect(isAutoRetryable("completed", DISCONNECTED_OUTCOME)).toBe(true);
        expect(planRetry(base({ status: "completed", callOutcome: DISCONNECTED_OUTCOME }))).toEqual(
            ist("2026-09-28T12:00:00"),
        );
        expect(planRetry(base({ status: "completed", callOutcome: DISCONNECTED_OUTCOME, attemptCount: 4 }))).toBeNull();
        expect(planRetry(base({ status: "completed", callOutcome: DISCONNECTED_OUTCOME, maxRetries: 0 }))).toBeNull();
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
        expect(planRetry(base({ attemptCount: 3, now }))).toEqual(ist("2026-09-29T10:00:00"));
    });
});

describe("planRetry — calling hours", () => {
    it("moves an evening retry to 10:00 the next day (dialler hours, B3)", () => {
        expect(planRetry(base({ now: ist("2026-09-28T18:30:00") }))).toEqual(ist("2026-09-29T10:00:00"));
    });

    it("skips Sunday", () => {
        // Saturday 18:30 + 1 h → Saturday 19:30 (shut) → Monday 10:00
        expect(planRetry(base({ now: ist("2026-10-03T18:30:00") }))).toEqual(ist("2026-10-05T10:00:00"));
    });

    it("an early-morning result waits for the window to open the same day", () => {
        expect(planRetry(base({ status: "busy", now: ist("2026-09-28T07:00:00") }))).toEqual(
            ist("2026-09-28T10:00:00"),
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
        expect(plan?.at).toEqual(ist("2026-10-01T10:00:00"));
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
        // Refunds used up: counted like any failure — an unreached lead, so
        // redialled within the 7 days (20 Nov 2026).
        expect(plan?.consumesAttempt).toBe(true);
    });

    it("is off for campaigns created with auto-retry off", () => {
        expect(planRetryDetailed(base({ status: "failed", callOutcome: SIP_403, maxRetries: 0 }))).toBeNull();
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

// 14 Nov 2026 — B.N. Enterprises: the dealer spoke on dial 2, the 15-min
// redial failed (SIP 480) and the row read "No Response".
describe("lastConversation — Connected sticks once the dealer spoke", () => {
    it("is null with no history or no conversation", () => {
        expect(lastConversation(null)).toBeNull();
        expect(lastConversation([])).toBeNull();
        expect(lastConversation([{ status: "no_response", outcome: "x", call_id: null }])).toBeNull();
    });
    it("returns the latest conversation, ignoring later unreached dials", () => {
        expect(
            lastConversation([
                { status: "completed", outcome: "done", call_id: "c1" },
                { status: "completed", outcome: "unknown", call_id: "c2" },
                { status: "no_response", outcome: "trigger_failed: SIP 480", call_id: null },
            ]),
        ).toEqual({ outcome: "unknown", call_id: "c2" });
    });
});

// 20 Nov 2026 — "completed status 100%": unreached leads keep being redialled
// for UNREACHED_RETRY_DAYS; only wrong numbers and IVR / switchboards stop.
describe("unreached leads are redialled for 7 days (20 Nov 2026)", () => {
    const firstDial = [{ at: ist("2026-09-28T10:00:00").toISOString(), counted: true }];
    const v3 = (disposition: string, over: Partial<RetryInput> = {}) =>
        planRetryDetailed(base({ disposition, history: firstDial, maxRetries: 5, ...over }));

    it.each([
        ["busy", "Busy in another call"],
        ["no_response", "Did not pick"],
        ["hung_up", "Hung up during intro"],
        ["voicemail", "Recording / voicemail"],
        ["no_response", "Incoming calls not available"],
    ])("%s / %s is booked on day 5 at dial 9", (status, disp) => {
        const plan = v3(disp, { status, attemptCount: 9, now: ist("2026-10-02T11:00:00") });
        expect(plan).not.toBeNull();
        expect(plan?.longHorizon).toBeUndefined();
    });

    it("voicemail is redialled more than once", () => {
        const history = [
            ...firstDial,
            { at: ist("2026-09-29T10:00:00").toISOString(), disp: "Recording / voicemail" },
        ];
        expect(v3("Recording / voicemail", { status: "voicemail", attemptCount: 3, history })).not.toBeNull();
    });

    it("Did not pick stops after day 7, not day 3", () => {
        expect(v3("Did not pick", { attemptCount: 7, now: ist("2026-10-01T15:00:00") })).not.toBeNull();
        expect(v3("Did not pick", { attemptCount: 13, dialsToday: 2, now: ist("2026-10-03T17:00:00") })).toBeNull();
    });

    it("a 'come back later' label on an early hang-up stays in the campaign", () => {
        const plan = v3("Need Some Time", { status: "hung_up", now: ist("2026-09-28T11:00:00") });
        expect(plan?.longHorizon).toBeUndefined();
        expect(plan?.at).toEqual(ist("2026-09-29T15:00:00")); // next day, other half (same offset)
    });

    it("an explicit refusal on an unconnected dial still rests 90 days", () => {
        expect(v3("Not Interested", { status: "hung_up" })?.longHorizon).toEqual({ once: true });
    });

    it.each([
        ["switchboard", null, "IVR / auto-attendant"],
        ["switchboard", null, "Hung up during intro"],
        ["failed", "invalid_number", "Incorrect / Invalid number"],
        ["failed", "invalid_number", "Did not pick"],
    ])("never redials %s / %s / %s", (status, outcome, disp) => {
        expect(v3(disp, { status, callOutcome: outcome, attemptCount: 2 })).toBeNull();
    });

    it("connected dials keep their own rules", () => {
        expect(v3("Need Some Time", { status: "completed" })?.longHorizon).toEqual({ once: false });
        expect(v3("Information Collected", { status: "completed" })).toBeNull();
    });
});
