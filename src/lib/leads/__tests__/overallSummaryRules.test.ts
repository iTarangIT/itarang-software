import { describe, expect, it } from "vitest";

import {
    SUMMARY_MAX_CHARS,
    SUMMARY_MAX_TRANSCRIPTS,
    humanCallLabel,
    humanCallNote,
    isSummaryCallTouchpoint,
    joinTranscripts,
    latestSummaryInput,
    overallSummaryPrompt,
    refreshOnTouchpointWrite,
    summaryRefreshDue,
} from "../overallSummaryRules";

const d = (s: string) => new Date(s);

describe("Overall Summary, option B (ID 118)", () => {
    it("is due when a transcript is newer than the last summary written", () => {
        expect(summaryRefreshDue(d("2026-10-16T10:00:00Z"), null)).toBe(true);
        expect(summaryRefreshDue(d("2026-10-16T10:00:00Z"), d("2026-10-16T09:00:00Z"))).toBe(true);
        expect(summaryRefreshDue(d("2026-10-16T10:00:00Z"), d("2026-10-16T10:00:00Z"))).toBe(false);
        expect(summaryRefreshDue(d("2026-10-16T10:00:00Z"), d("2026-10-16T11:00:00Z"))).toBe(false);
        expect(summaryRefreshDue(null, null)).toBe(false);
    });

    it("refreshes after calls only", () => {
        expect(isSummaryCallTouchpoint("ai_call")).toBe(true);
        expect(isSummaryCallTouchpoint("inside_sales_call")).toBe(true);
        expect(isSummaryCallTouchpoint("visit")).toBe(false);
        expect(isSummaryCallTouchpoint("status_change")).toBe(false);
    });

    it("joins the transcripts oldest first, newest calls kept, empty ones skipped", () => {
        const calls = [
            { at: d("2026-10-03T05:00:00Z"), transcript: "third" },
            { at: d("2026-10-01T05:00:00Z"), transcript: "first" },
            { at: d("2026-10-02T05:00:00Z"), transcript: "   " },
            { at: d("2026-10-02T06:00:00Z"), transcript: "second" },
        ];
        const text = joinTranscripts(calls);
        expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
        expect(text.indexOf("second")).toBeLessThan(text.indexOf("third"));
        expect(text.match(/--- Call/g)).toHaveLength(3);
    });

    it("keeps at most the newest SUMMARY_MAX_TRANSCRIPTS calls and SUMMARY_MAX_CHARS characters", () => {
        const many = Array.from({ length: SUMMARY_MAX_TRANSCRIPTS + 5 }, (_, i) => ({
            at: new Date(Date.UTC(2026, 9, 1 + i)),
            transcript: `call-${i}`,
        }));
        const text = joinTranscripts(many);
        expect(text).not.toContain("call-0\n");
        expect(text).toContain(`call-${SUMMARY_MAX_TRANSCRIPTS + 4}`);
        const huge = [
            { at: d("2026-10-01T00:00:00Z"), transcript: "old ".repeat(SUMMARY_MAX_CHARS / 2) },
            { at: d("2026-10-02T00:00:00Z"), transcript: "new call" },
        ];
        const cut = joinTranscripts(huge);
        expect(cut.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
        expect(cut).toContain("new call");
    });

    it("names the dealer in the prompt and falls back when unknown", () => {
        expect(overallSummaryPrompt({ transcripts: "x", dealerName: "Ravi", shopName: "Ravi EV", location: "Pune" })).toContain(
            "a dealer named Ravi from Ravi EV in Pune",
        );
        expect(overallSummaryPrompt({ transcripts: "x" })).toContain("a dealer named the dealer from their shop in an unknown location");
    });
});

describe("ID 118 item 2 (18 Oct): NeoDove and manually logged calls feed the summary", () => {
    it("a human call adds its status, outcome and notes", () => {
        const note = humanCallNote({
            source: "neodove",
            callStatus: "connected",
            disposition: "Interested - call back",
            remarks: "Wants 10 batteries next month",
            durationSec: 182.4,
        });
        expect(note).toBe("Call status: connected\nDuration: 182s\nOutcome: Interested - call back\nNotes: Wants 10 batteries next month");
    });

    it("a call with no remarks and no outcome adds nothing", () => {
        expect(humanCallNote({ source: "manual", callStatus: "not_connected", disposition: null, remarks: "  ", durationSec: 0 })).toBeNull();
        expect(humanCallNote({ source: "manual", callStatus: null, disposition: "", remarks: null, durationSec: null })).toBeNull();
    });

    it("labels each kind of human call; AI transcripts keep the old block heading", () => {
        expect(humanCallLabel("neodove")).toMatch(/NeoDove/);
        expect(humanCallLabel("manual")).toMatch(/logged by the rep/);
        expect(humanCallLabel("recording")).toMatch(/transcript/);
        const text = joinTranscripts([
            { at: d("2026-10-01T05:00:00Z"), transcript: "ai words" },
            { at: d("2026-10-02T05:00:00Z"), transcript: "Notes: x", label: humanCallLabel("neodove") },
        ]);
        expect(text).toMatch(/--- Call 1 \([^)]+\) ---\nai words/);
        expect(text).toMatch(/--- Call 2 \([^)]+\) · NeoDove call \(notes\) ---\nNotes: x/);
        expect(overallSummaryPrompt({ transcripts: text })).toMatch(/marked "\(notes\)" are the rep's notes/);
    });

    it("due-ness uses when the CRM got the text (a replayed old NeoDove call is new)", () => {
        const latest = latestSummaryInput([
            { at: d("2026-10-01T05:00:00Z"), transcript: "ai" },
            { at: d("2026-09-01T05:00:00Z"), seenAt: d("2026-10-18T05:00:00Z"), transcript: "replayed" },
            { at: d("2026-10-19T05:00:00Z"), seenAt: d("2026-10-19T05:00:00Z"), transcript: "  " },
        ]);
        expect(latest).toEqual(d("2026-10-18T05:00:00Z"));
        expect(summaryRefreshDue(latest, d("2026-10-17T00:00:00Z"))).toBe(true);
        expect(latestSummaryInput([])).toBeNull();
    });

    it("writeTouchpoint schedules AI and manual calls; a NeoDove call waits for attachCallEvidence", () => {
        expect(refreshOnTouchpointWrite("ai_call", null)).toBe(true);
        expect(refreshOnTouchpointWrite("inside_sales_call", null)).toBe(true);
        expect(refreshOnTouchpointWrite("inside_sales_call", "manual")).toBe(true);
        expect(refreshOnTouchpointWrite("inside_sales_call", "neodove")).toBe(false);
        expect(refreshOnTouchpointWrite("visit", null)).toBe(false);
    });
});
