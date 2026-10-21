/**
 * ID 192 — the Leads list's Idle number is WORKING days on the follow-up
 * ageing basis, and every lead with a basis lands in exactly one band.
 */
import { describe, expect, it } from "vitest";
import { IDLE_RANGES, idleBand, idleDays, idleSeverity, isIdleRangeKey } from "../idle";

const now = Date.parse("2026-10-21T06:30:00Z"); // Wed 21 Oct 12:00 IST
const lead = (o: Partial<{ last_worked_at: string | null; assigned_at: string | null; next_follow_up_at: string | null; created_at: string | null }>) => ({
    last_worked_at: null,
    assigned_at: null,
    next_follow_up_at: null,
    created_at: null,
    ...o,
});

describe("idleDays — working days", () => {
    it("skips Sundays and holidays", () => {
        // Last worked Sat 17 Oct: Mon, Tue, Wed = 3 working days (Sunday off).
        expect(idleDays(lead({ last_worked_at: "2026-10-17T06:30:00Z" }), now)).toBe(3);
        expect(idleDays(lead({ last_worked_at: "2026-10-17T06:30:00Z" }), now, new Set(["2026-10-20"]))).toBe(2);
    });
    it("a follow-up ahead reads 0 and is 'Under 30'", () => {
        const d = idleDays(lead({ last_worked_at: "2026-08-01T06:30:00Z", next_follow_up_at: "2026-10-25T06:30:00Z" }), now);
        expect(d).toBe(0);
        expect(idleBand(d)).toBe("0-29");
    });
    it("a follow-up over 30 days ahead is ignored", () => {
        const d = idleDays(lead({ last_worked_at: "2026-10-17T06:30:00Z", next_follow_up_at: "2027-01-01T06:30:00Z" }), now);
        expect(d).toBe(3);
    });
    it("null without any date", () => {
        expect(idleDays(lead({}), now)).toBeNull();
        expect(idleBand(null)).toBeNull();
    });
});

describe("idle bands (30 / 60 / 90 working days)", () => {
    it("every count is in exactly one band, inclusive at both ends", () => {
        const bands = ["0-29", "30-59", "60-89", "90+"] as const;
        for (const n of [0, 1, 29, 30, 59, 60, 89, 90, 400]) {
            const hits = bands.filter((k) => {
                const r = IDLE_RANGES[k];
                return n >= r.min && (r.max == null || n <= r.max);
            });
            expect(hits).toEqual([idleBand(n)]);
        }
    });
    it("severity follows the bands", () => {
        expect(idleSeverity(0)).toBe("fresh");
        expect(idleSeverity(30)).toBe("watch");
        expect(idleSeverity(60)).toBe("stale");
        expect(idleSeverity(90)).toBe("cold");
    });
    it("offers 'Idle past limit' as a filter value", () => {
        expect(isIdleRangeKey("past_limit")).toBe(true);
        expect(IDLE_RANGES.past_limit.label).toBe("Idle past limit");
    });
});
