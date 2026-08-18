// Tests for the campaign failure-reason display vocabulary.
//
// Every "real row" case below was taken from an actual dialer_campaign_leads
// row on sandbox, because the whole point of this module is that the provider's
// free-text strings are not a vocabulary we control — a rule invented from
// imagination would classify strings that never occur and miss the ones that do.

import { describe, expect, it } from "vitest";
import {
    deriveFailureReason,
    isRetryableFailure,
    FAILURE_REASON_CODES,
    type FailureReasonInput,
} from "@/lib/ai-dialer/failureReason";

const failed = (over: Partial<FailureReasonInput> = {}): FailureReasonInput => ({
    status: "failed",
    callOutcome: null,
    ...over,
});

describe("real rows observed in dialer_campaign_leads", () => {
    // The largest bucket on sandbox — 100 rows — and the one that matters most:
    // nothing was wrong with these dealers.
    it("a missing from_number is OUR fault, not the dealer's", () => {
        const r = deriveFailureReason(
            failed({
                callOutcome:
                    "trigger_failed: Calling from_number doesn't exist for vobiz. Please check your agent telephony provider.",
            }),
        );
        expect(r?.code).toBe("config_error");
        expect(r?.ourFault).toBe(true);
        expect(r?.detail).toContain("from_number");
    });

    it("an invalid API key is OUR fault", () => {
        const r = deriveFailureReason(
            failed({ callOutcome: "trigger_failed: Invalid API key" }),
        );
        expect(r?.code).toBe("config_error");
        expect(r?.ourFault).toBe(true);
    });

    it("a missing phone-number document is OUR fault", () => {
        const r = deriveFailureReason(
            failed({
                callOutcome:
                    "trigger_failed: Document with id phnum_6801kp1hstn0f5kt2khncbjs3pe3 not found.",
            }),
        );
        expect(r?.code).toBe("config_error");
    });

    it("SIP 486 is a busy line", () => {
        const r = deriveFailureReason(
            failed({
                callOutcome:
                    "trigger_failed: INVITE failed: sip status: 486: Busy Here (SIP 486)",
            }),
        );
        expect(r?.code).toBe("busy");
        expect(r?.retryable).toBe(true);
        expect(r?.ourFault).toBe(false);
    });

    it("SIP 480 reads as not answered, not as a network fault", () => {
        expect(
            deriveFailureReason(
                failed({
                    callOutcome:
                        "trigger_failed: INVITE failed: sip status: 480: Temporarily Unavailable (SIP 480)",
                }),
            )?.code,
        ).toBe("not_answered");
    });

    it("a SIP timeout is a network issue", () => {
        expect(
            deriveFailureReason(
                failed({ callOutcome: "trigger_failed: sip request timed out" }),
            )?.code,
        ).toBe("technical");
    });

    it("a bare trigger_failed says so honestly rather than guessing", () => {
        const r = deriveFailureReason(failed({ callOutcome: "trigger_failed" }));
        expect(r?.code).toBe("unknown");
        expect(r?.label).toBe("Failed");
    });

    it("stopped_by_user and ineligible rows are not dealer outcomes", () => {
        expect(deriveFailureReason(failed({ callOutcome: "stopped_by_user" }))?.code).toBe(
            "stopped",
        );
        expect(
            deriveFailureReason(failed({ callOutcome: "ineligible_active_lead" }))?.code,
        ).toBe("ineligible");
        expect(
            deriveFailureReason(failed({ callOutcome: "ineligible_ai_connected" }))?.code,
        ).toBe("ineligible");
        expect(deriveFailureReason(failed({ callOutcome: "no_phone" }))?.code).toBe(
            "ineligible",
        );
    });
});

describe("a transcript outranks the outcome string", () => {
    // THE bug in the screenshot: a row that plainly connected — recording and
    // transcript present — still read "Trigger failed", because the outcome
    // string was believed over the evidence.
    it("never reports a trigger failure for a call that produced a transcript", () => {
        const r = deriveFailureReason({
            status: "failed",
            callOutcome: "trigger_failed: INVITE failed: sip status: 486: Busy Here",
            hasTranscript: true,
            bandCallStatus: "dropped_empty",
        });
        expect(r?.code).toBe("silent_call");
        expect(r?.label).not.toMatch(/trigger/i);
    });

    it("dropped_empty is a silent call, and is NOT retryable", () => {
        const r = deriveFailureReason({
            status: "completed",
            callOutcome: "dropped_empty",
            hasTranscript: true,
            bandCallStatus: "dropped_empty",
        });
        expect(r?.code).toBe("silent_call");
        // The dealer WAS reached, so the AI-connected hard block refuses them
        // anyway — offering a retry would be offering an action that gets
        // refused.
        expect(r?.retryable).toBe(false);
    });

    it("an unreadable but real conversation is 'no response', not a failure", () => {
        expect(
            deriveFailureReason({
                status: "completed",
                callOutcome: "needs_review",
                hasTranscript: true,
                bandCallStatus: "complete",
            })?.code,
        ).toBe("no_response");
    });

    // A genuine conversation has nothing to explain — the analyzer outcome
    // already describes it, and inventing a "failure" for it would be wrong.
    it("returns null for a real conversation", () => {
        expect(
            deriveFailureReason({
                status: "completed",
                callOutcome: "interested",
                hasTranscript: true,
                bandCallStatus: "complete",
            }),
        ).toBeNull();
    });

    // The exact shape in the screenshot: chip says Failed, drawer plays a
    // recording. A failed row must ALWAYS get a reason — a bare "Failed" next
    // to a playable recording is the bug this module exists to remove.
    it("still names a reason when a failed row has a transcript", () => {
        const r = deriveFailureReason({
            status: "failed",
            callOutcome: "done",
            hasTranscript: true,
            bandCallStatus: "complete",
        });
        expect(r).not.toBeNull();
        expect(r?.code).toBe("no_response");
        expect(r?.retryable).toBe(false);
    });

    it("returns null for rows that have not failed and have no transcript", () => {
        expect(deriveFailureReason({ status: "pending", callOutcome: null })).toBeNull();
        expect(deriveFailureReason({ status: "calling", callOutcome: null })).toBeNull();
    });
});

describe("provider statuses", () => {
    it("classifies the common ones from the log when the outcome is bare", () => {
        const cases: [string, string][] = [
            ["no_answer", "not_answered"],
            ["no-answer", "not_answered"],
            ["busy", "busy"],
            ["voicemail", "voicemail"],
            ["call-disconnected", "disconnected"],
        ];
        for (const [providerStatus, code] of cases) {
            expect(
                deriveFailureReason(failed({ callOutcome: null, providerStatus }))?.code,
                providerStatus,
            ).toBe(code);
        }
    });
});

describe("invariants", () => {
    it("never returns a code outside the declared set", () => {
        const outcomes = [
            "trigger_failed",
            "trigger_failed: anything at all",
            "trigger_exception: boom",
            "stopped_by_user",
            "no_webhook",
            "busy",
            "done",
            "",
            null,
            "🙂",
        ];
        for (const callOutcome of outcomes) {
            for (const hasTranscript of [true, false, null]) {
                const r = deriveFailureReason({
                    status: "failed",
                    callOutcome,
                    hasTranscript,
                });
                if (!r) continue;
                expect(
                    (FAILURE_REASON_CODES as readonly string[]).includes(r.code),
                    `bad code: ${r.code}`,
                ).toBe(true);
                expect(r.label.length).toBeGreaterThan(0);
                expect(r.hint.length).toBeGreaterThan(0);
            }
        }
    });

    // The two CONNECTED reasons are the only non-retryable dealer outcomes, and
    // that is not a style choice — the AI-connected hard block will refuse them,
    // so a retry would silently do nothing.
    it("marks exactly the connected outcomes as non-retryable", () => {
        expect(isRetryableFailure(failed({ callOutcome: "dropped_empty", hasTranscript: true }))).toBe(false);
        expect(isRetryableFailure({ status: "completed", callOutcome: "needs_review", hasTranscript: true })).toBe(false);
        expect(isRetryableFailure(failed({ callOutcome: "trigger_failed" }))).toBe(true);
        expect(isRetryableFailure(failed({ callOutcome: "trigger_failed: 486 Busy Here" }))).toBe(true);
    });

    it("never invents a detail string", () => {
        // `detail` must be provider text or null — never a label we made up.
        const r = deriveFailureReason(failed({ callOutcome: "trigger_failed" }));
        expect(r?.detail).toBeNull();
    });
});
