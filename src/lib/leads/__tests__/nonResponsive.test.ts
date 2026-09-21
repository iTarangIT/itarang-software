// Tests for the non-responsive rule (review R-16, metric M20): 6 calls on 6
// different IST days within 45 days, none connected.

import { describe, expect, it } from "vitest";
import { isNonResponsive } from "@/lib/leads/nonResponsive";

const NOW = new Date("2026-09-21T06:00:00Z");
const daysAgo = (n: number, hourUtc = 6) =>
    new Date(Date.UTC(2026, 8, 21 - n, hourUtc, 0, 0));
const calls = (days: number[], status = "not_reachable") =>
    days.map((d) => ({ performed_at: daysAgo(d), call_status: status }));

describe("isNonResponsive", () => {
    it("flags 6 unanswered calls on 6 different days", () => {
        expect(isNonResponsive(calls([1, 3, 5, 8, 12, 20]), NOW)).toBe(true);
    });

    it("needs 6 different DAYS, not 6 calls", () => {
        const sameDays = calls([1, 1, 1, 2, 2, 3, 3, 4]);
        expect(isNonResponsive(sameDays, NOW)).toBe(false);
    });

    it("one connected call in the window clears it", () => {
        const c = [...calls([1, 3, 5, 8, 12, 20]), { performed_at: daysAgo(30), call_status: "connected" }];
        expect(isNonResponsive(c, NOW)).toBe(false);
    });

    it("ignores calls older than 45 days", () => {
        expect(isNonResponsive(calls([1, 3, 5, 8, 50, 60]), NOW)).toBe(false);
        // …including an old connected call, which no longer protects the lead.
        const c = [...calls([1, 3, 5, 8, 12, 20]), { performed_at: daysAgo(60), call_status: "connected" }];
        expect(isNonResponsive(c, NOW)).toBe(true);
    });

    it("counts days in IST — 20:00 and 21:00 UTC are different IST days", () => {
        // 20:00 UTC = 01:30 IST next day; 17:00 UTC = 22:30 IST same day.
        const c = [
            { performed_at: daysAgo(10, 17), call_status: "not_responding" },
            { performed_at: daysAgo(10, 20), call_status: "not_responding" },
            ...calls([1, 2, 3, 4]),
        ];
        expect(isNonResponsive(c, NOW)).toBe(true);
    });
});
