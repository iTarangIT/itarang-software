// ID 212 — the morning Missed Callbacks email: which days it covers, and how a
// missed callback's outcome reads.
import { describe, expect, it } from "vitest";

import { missedWindow, sinceText } from "@/lib/digests/kinds/missed-callbacks";

describe("missedWindow", () => {
    it("covers yesterday", () => {
        expect(missedWindow("2026-11-05")).toEqual({ from: "2026-11-04", to: "2026-11-04" }); // Thursday
    });
    it("Monday's mail covers Saturday and Sunday", () => {
        expect(missedWindow("2026-11-09")).toEqual({ from: "2026-11-07", to: "2026-11-08" });
    });
    it("crosses a month end", () => {
        expect(missedWindow("2026-12-01")).toEqual({ from: "2026-11-30", to: "2026-11-30" });
    });
});

describe("sinceText", () => {
    const fmt = (iso: string) => `@${iso}`;
    it("a later call wins over the status", () => {
        expect(sinceText({ status: "open", called_after: "X", completed_at: null }, fmt)).toBe("Called later, @X");
    });
    it("open, expired, cancelled, done", () => {
        expect(sinceText({ status: "open", called_after: null, completed_at: null }, fmt)).toBe("Still not done");
        expect(sinceText({ status: "expired", called_after: null, completed_at: null }, fmt)).toMatch(/^Closed: expired/);
        expect(sinceText({ status: "cancelled", called_after: null, completed_at: null }, fmt)).toBe("Closed: cancelled");
        expect(sinceText({ status: "done", called_after: null, completed_at: "Y" }, fmt)).toBe("Marked done, @Y");
    });
});
