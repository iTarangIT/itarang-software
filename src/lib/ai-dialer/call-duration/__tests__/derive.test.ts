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
        expect(deriveDurationSeconds(45, started, "2026-08-13T10:05:00.000Z")).toBe(45);
    });

    it("accepts the string form a correlated subquery can return", () => {
        expect(deriveDurationSeconds("45", null, null)).toBe(45);
    });

    it("rounds a fractional provider value to whole seconds", () => {
        expect(deriveDurationSeconds(11.4, null, null)).toBe(11);
    });

    it.each([0, -1, Number.NaN, null, undefined])(
        "falls through to the wall clock when the provider value is %p",
        (provided) => {
            expect(deriveDurationSeconds(provided, started, "2026-08-13T10:00:30.000Z")).toBe(30);
        },
    );

    it("returns null when neither source is usable", () => {
        expect(deriveDurationSeconds(null, null, null)).toBeNull();
        expect(deriveDurationSeconds(0, started, null)).toBeNull();
    });

    it("rejects a zero-length or negative wall clock", () => {
        expect(deriveDurationSeconds(null, started, started)).toBeNull();
        expect(deriveDurationSeconds(null, started, "2026-08-13T09:59:55.000Z")).toBeNull();
    });

    it("clamps the wall clock at DURATION_MAX_SECONDS", () => {
        const justUnder = new Date(
            new Date(started).getTime() + (DURATION_MAX_SECONDS - 1) * 1000,
        ).toISOString();
        const exactly = new Date(
            new Date(started).getTime() + DURATION_MAX_SECONDS * 1000,
        ).toISOString();

        expect(deriveDurationSeconds(null, started, justUnder)).toBe(DURATION_MAX_SECONDS - 1);
        // A "call" of exactly two hours is a bookkeeping artefact, not a call.
        expect(deriveDurationSeconds(null, started, exactly)).toBeNull();
    });

    it("lets the provider win even when the wall clock is much larger", () => {
        expect(deriveDurationSeconds(12, started, "2026-08-13T10:30:00.000Z")).toBe(12);
    });

    it("accepts Date objects as well as ISO strings", () => {
        expect(
            deriveDurationSeconds(null, new Date(started), new Date("2026-08-13T10:00:08.000Z")),
        ).toBe(8);
    });
});

describe("isCallConnected", () => {
    it("counts a transcript as proof on its own", () => {
        expect(isCallConnected({ hasTranscript: true, durationSeconds: null })).toBe(true);
    });

    it("counts measurable talk time as proof on its own", () => {
        expect(isCallConnected({ hasTranscript: false, durationSeconds: 4 })).toBe(true);
    });

    it("rejects a call with neither", () => {
        expect(isCallConnected({ hasTranscript: false, durationSeconds: null })).toBe(false);
        expect(isCallConnected({ hasTranscript: null, durationSeconds: 0 })).toBe(false);
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

    it("defines connected as transcript OR positive duration", () => {
        expect(CONNECTED_PREDICATE).toContain("acl.transcript IS NOT NULL");
        expect(CONNECTED_PREDICATE).toContain("> 0");
    });

    it("is a literal with nothing left to interpolate", () => {
        expect(DURATION_SECONDS_PREDICATE).not.toContain("${");
        expect(CONNECTED_PREDICATE).not.toContain("${");
    });
});
