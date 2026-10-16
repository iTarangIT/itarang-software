import { describe, expect, it } from "vitest";

import {
    SUMMARY_MAX_CHARS,
    SUMMARY_MAX_TRANSCRIPTS,
    isSummaryCallTouchpoint,
    joinTranscripts,
    overallSummaryPrompt,
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
