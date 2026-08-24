import { describe, expect, it } from "vitest";
import {
    CONNECTED_PREDICATE,
    DURATION_MAX_SECONDS,
    DURATION_SECONDS_PREDICATE,
    deriveDurationSeconds,
    isCallConnected,
} from "../derive";

describe("deriveDurationSeconds", () => {
    const started = "2026-08-13T10:00:00.000Z";

    it("prefers the provider value when it is usable", () => {
        expect(deriveDurationSeconds(45, started, "2026-08-13T10:05:00.000Z", false)).toBe(45);
    });

    it("accepts the string form a correlated subquery can return", () => {
        expect(deriveDurationSeconds("45", null, null, false)).toBe(45);
    });

    it("rounds a fractional provider value to whole seconds", () => {
        expect(deriveDurationSeconds(11.4, null, null, false)).toBe(11);
    });

    it.each([0, -1, Number.NaN, null, undefined])(
        "falls through to the wall clock when the provider value is %p AND a transcript proves the call connected",
        (provided) => {
            expect(
                deriveDurationSeconds(provided, started, "2026-08-13T10:00:30.000Z", true),
            ).toBe(30);
        },
    );

    // THE REGRESSION THIS FILE EXISTS FOR. A `trigger_failed` lead — the dialer
    // was rejected by the provider and no phone ever rang — still carries a
    // started_at/completed_at pair bracketing the failed trigger attempt. Read
    // as a duration, that bookkeeping latency became a 30-second "call" and put
    // 75 never-placed calls into the campaign histogram.
    it.each([0, -1, Number.NaN, null, undefined])(
        "refuses the wall clock when the provider value is %p and nothing proves the call connected",
        (provided) => {
            expect(
                deriveDurationSeconds(provided, started, "2026-08-13T10:00:30.000Z", false),
            ).toBeNull();
        },
    );

    it("returns null when neither source is usable", () => {
        expect(deriveDurationSeconds(null, null, null, true)).toBeNull();
        expect(deriveDurationSeconds(0, started, null, true)).toBeNull();
    });

    it("rejects a zero-length or negative wall clock", () => {
        expect(deriveDurationSeconds(null, started, started, true)).toBeNull();
        expect(deriveDurationSeconds(null, started, "2026-08-13T09:59:55.000Z", true)).toBeNull();
    });

    it("clamps the wall clock at DURATION_MAX_SECONDS", () => {
        const justUnder = new Date(
            new Date(started).getTime() + (DURATION_MAX_SECONDS - 1) * 1000,
        ).toISOString();
        const exactly = new Date(
            new Date(started).getTime() + DURATION_MAX_SECONDS * 1000,
        ).toISOString();

        expect(deriveDurationSeconds(null, started, justUnder, true)).toBe(
            DURATION_MAX_SECONDS - 1,
        );
        // A "call" of exactly two hours is a bookkeeping artefact, not a call.
        expect(deriveDurationSeconds(null, started, exactly, true)).toBeNull();
    });

    it("lets the provider win even when the wall clock is much larger", () => {
        expect(deriveDurationSeconds(12, started, "2026-08-13T10:30:00.000Z", true)).toBe(12);
    });

    it("accepts Date objects as well as ISO strings", () => {
        expect(
            deriveDurationSeconds(
                null,
                new Date(started),
                new Date("2026-08-13T10:00:08.000Z"),
                true,
            ),
        ).toBe(8);
    });

    it("agrees with isCallConnected — a duration exists only for a connected call", () => {
        const cases: Array<[number | null, boolean]> = [
            [45, false], // provider talk time: connected
            [null, true], // transcript: connected
            [null, false], // neither: not connected
            [0, false], // a zero-second provider value is not talk time
        ];
        for (const [provided, hasTranscript] of cases) {
            const duration = deriveDurationSeconds(
                provided,
                started,
                "2026-08-13T10:00:30.000Z",
                hasTranscript,
            );
            const connected = isCallConnected({
                hasTranscript,
                providerDurationSeconds: provided,
            });
            expect(duration != null).toBe(connected);
        }
    });
});

describe("isCallConnected", () => {
    it("counts a transcript as proof on its own", () => {
        expect(isCallConnected({ hasTranscript: true, providerDurationSeconds: null })).toBe(
            true,
        );
    });

    it("counts provider-reported talk time as proof on its own", () => {
        expect(isCallConnected({ hasTranscript: false, providerDurationSeconds: 4 })).toBe(true);
    });

    it("accepts the string form a correlated subquery can return", () => {
        expect(isCallConnected({ hasTranscript: false, providerDurationSeconds: "4" })).toBe(
            true,
        );
    });

    it("rejects a call with neither", () => {
        expect(isCallConnected({ hasTranscript: false, providerDurationSeconds: null })).toBe(
            false,
        );
        expect(isCallConnected({ hasTranscript: null, providerDurationSeconds: 0 })).toBe(false);
    });

    // Wall-clock time is deliberately absent from this function's inputs: it
    // measures how long the DIALER took, which a failed trigger has plenty of.
    it("treats an absent provider value as no evidence", () => {
        expect(isCallConnected({ hasTranscript: false, providerDurationSeconds: undefined })).toBe(
            false,
        );
    });
});

// These pins are what make it safe to swap the duplicated CASE expressions in
// unified/route.ts and ai-dialer/campaigns/route.ts for DURATION_SECONDS_SQL
// later: if the predicate drifts, this fails rather than the two copies quietly
// disagreeing. Same reasoning as the AI_CONNECTED_PREDICATE pin in
// exclusionFilter.test.ts.
describe("SQL predicates", () => {
    it("carries the clamp, both sources and the required aliases", () => {
        expect(DURATION_SECONDS_PREDICATE).toContain(String(DURATION_MAX_SECONDS));
        expect(DURATION_SECONDS_PREDICATE).toContain("acl.call_duration");
        expect(DURATION_SECONDS_PREDICATE).toContain("extract(epoch");
        expect(DURATION_SECONDS_PREDICATE).toContain("dcl.started_at");
        expect(DURATION_SECONDS_PREDICATE).toContain("dcl.completed_at");
    });

    it("yields NULL rather than 0 for an unknown duration", () => {
        expect(DURATION_SECONDS_PREDICATE).toContain("ELSE NULL");
    });

    it("gates the wall-clock arm on the transcript, not on the wall clock alone", () => {
        // The SQL twin has to encode the same "a duration belongs to a
        // conversation" rule as the TypeScript one. Without the transcript
        // test, every trigger_failed row is bucketed by dialer latency.
        expect(DURATION_SECONDS_PREDICATE).toContain("acl.transcript IS NOT NULL");
    });

    it("defines connected as transcript OR positive PROVIDER duration", () => {
        expect(CONNECTED_PREDICATE).toContain("acl.transcript IS NOT NULL");
        expect(CONNECTED_PREDICATE).toContain("acl.call_duration");
        expect(CONNECTED_PREDICATE).toContain("> 0");
    });

    it("keeps wall-clock time out of the connection test entirely", () => {
        expect(CONNECTED_PREDICATE).not.toContain("dcl.started_at");
        expect(CONNECTED_PREDICATE).not.toContain("dcl.completed_at");
        expect(CONNECTED_PREDICATE).not.toContain("extract(epoch");
    });

    it("is a literal with nothing left to interpolate", () => {
        expect(DURATION_SECONDS_PREDICATE).not.toContain("${");
        expect(CONNECTED_PREDICATE).not.toContain("${");
    });
});
