// Tests for the call-history merge — specifically the third source added on
// 2026-08-03: calls made in an EXTERNAL system (NeoDove) and recorded as
// lead_touchpoints.
//
// The bug these pin: /leads/[id] read only ai_call_logs + follow_up_history, so a
// NeoDove call showed "Total Calls 0 · Call History (0 total) · No calls made
// yet" on a lead whose Activity timeline, on the same screen, described the call.
// That reads as the integration being broken rather than as two stores with
// different jobs.

import { describe, expect, it } from "vitest";
import {
    isExternalCallTouchpoint,
    normalizeCalls,
    type ExternalCallTouchpoint,
} from "../normalizeCalls";

const neodoveCall = (
    over: Partial<ExternalCallTouchpoint> = {},
): ExternalCallTouchpoint => ({
    id: "tp-1",
    touchpoint_type: "inside_sales_call",
    call_status: null,
    external_system: "neodove",
    external_agent_name: "Rushikesh",
    recording_url: null,
    remarks: "[NeoDove] Disposition: Interested · Stage: Cold",
    created_at: "2026-08-03T14:01:15.566Z",
    ...over,
});

describe("isExternalCallTouchpoint", () => {
    it("accepts an external inside-sales call", () => {
        expect(
            isExternalCallTouchpoint({
                touchpoint_type: "inside_sales_call",
                external_system: "neodove",
            }),
        ).toBe(true);
    });

    it("REJECTS a priority-dial hand-off request", () => {
        // A hand-off is a request for someone to call, not a call. Counting it
        // would inflate Total Calls with work nobody has done yet — the same
        // rule src/lib/lifecycle/touchpointTypes.ts states for its own reasons.
        expect(
            isExternalCallTouchpoint({
                touchpoint_type: "neodove_dial_request",
                external_system: "neodove",
            }),
        ).toBe(false);
    });

    it("rejects our own internal touchpoints", () => {
        // No external_system = we did it, and it is either already in
        // ai_call_logs or was never a call at all.
        expect(
            isExternalCallTouchpoint({
                touchpoint_type: "inside_sales_call",
                external_system: null,
            }),
        ).toBe(false);
        expect(
            isExternalCallTouchpoint({
                touchpoint_type: "status_change_note",
                external_system: "neodove",
            }),
        ).toBe(false);
    });
});

describe("normalizeCalls with external calls", () => {
    it("counts an external call so Total Calls is no longer 0", () => {
        const calls = normalizeCalls([], [], [neodoveCall()]);
        expect(calls).toHaveLength(1);
        expect(calls[0].source).toBe("touchpoint");
        expect(calls[0].index).toBe(1);
    });

    it("surfaces the vendor and the agent on the row", () => {
        const [c] = normalizeCalls([], [], [neodoveCall()]);
        expect(c.provider).toBe("neodove");
        expect(c.external_agent_name).toBe("Rushikesh");
    });

    it("uses the disposition line as the outcome, so Latest Status is not a dash", () => {
        const [c] = normalizeCalls([], [], [neodoveCall()]);
        expect(c.outcome).toContain("Interested");
    });

    it("contributes NO transcript and NO intent score", () => {
        // The fixed NeoDove payload carries neither. Total Calls must move;
        // Transcripts and Avg Intent Score must not, or both become nonsense.
        const [c] = normalizeCalls([], [], [neodoveCall()]);
        expect(c.transcript).toBeNull();
        expect(c.intent_score).toBeNull();
    });

    it("is NOT deduped against an AI call at the same moment", () => {
        // Two systems, two different calls. The 2-minute dedup window exists to
        // reconcile ai_call_logs against legacy follow_up_history — the SAME call
        // recorded twice — and applying it here would delete a real call.
        const at = "2026-08-03T14:01:15.000Z";
        const calls = normalizeCalls(
            [
                {
                    id: "log-1",
                    provider: "bolna",
                    status: "completed",
                    intent_score: 70,
                    transcript: "hello",
                    summary: null,
                    recording_url: null,
                    call_duration: 60,
                    band: "Warm",
                    call_status: "complete",
                    info_signals_count: 2,
                    started_at: at,
                    created_at: at,
                },
            ],
            [],
            [neodoveCall({ created_at: at })],
        );
        expect(calls).toHaveLength(2);
    });

    it("orders every source into one chronological list, oldest first", () => {
        const calls = normalizeCalls(
            [
                {
                    id: "log-1",
                    provider: "bolna",
                    status: "completed",
                    intent_score: null,
                    transcript: null,
                    summary: null,
                    recording_url: null,
                    call_duration: null,
                    band: null,
                    call_status: null,
                    info_signals_count: null,
                    started_at: "2026-08-01T09:00:00.000Z",
                    created_at: "2026-08-01T09:00:00.000Z",
                },
            ],
            [{ attempt: 1, called_at: "2026-08-02T09:00:00.000Z", outcome: "no_answer" }],
            [neodoveCall({ created_at: "2026-08-03T09:00:00.000Z" })],
        );
        expect(calls.map((c) => c.source)).toEqual(["log", "history", "touchpoint"]);
        expect(calls.map((c) => c.index)).toEqual([1, 2, 3]);
    });

    it("defaults to the old two-source behaviour when none are passed", () => {
        // Every other caller of normalizeCalls must be unaffected.
        expect(normalizeCalls([], [])).toEqual([]);
    });
});
