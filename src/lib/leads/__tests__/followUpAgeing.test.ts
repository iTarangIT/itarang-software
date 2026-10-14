import { describe, expect, it } from "vitest";

import {
    FOLLOW_UP_AGEING_BASIS_TEXT,
    FOLLOW_UP_HORIZON_DAYS,
    followUpAgeingBasis,
    followUpPending,
} from "../followUpAgeing";

const NOW = Date.parse("2026-10-14T12:00:00+05:30");
const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString();
const at = (n: number) => new Date(NOW + n * 86_400_000);

describe("followUpAgeingBasis", () => {
    it("a follow-up still ahead puts the basis in the future (0 days idle)", () => {
        const b = followUpAgeingBasis({ last_worked_at: day(-20), assigned_at: day(-30), next_follow_up_at: day(3) }, NOW);
        expect(b).toEqual(at(3));
        expect(followUpPending(day(3), NOW)).toBe(true);
    });

    it("a passed follow-up counts from its date", () => {
        const b = followUpAgeingBasis({ last_worked_at: day(-20), assigned_at: day(-30), next_follow_up_at: day(-4) }, NOW);
        expect(b).toEqual(at(-4));
        expect(followUpPending(day(-4), NOW)).toBe(false);
    });

    it("work logged after a passed follow-up wins", () => {
        const b = followUpAgeingBasis({ last_worked_at: day(-1), next_follow_up_at: day(-4) }, NOW);
        expect(b).toEqual(at(-1));
    });

    it("no follow-up: the later of the last work and the assignment", () => {
        // Reassigned after the last call: the new holder's clock starts at assignment.
        expect(followUpAgeingBasis({ last_worked_at: day(-20), assigned_at: day(-2) }, NOW)).toEqual(at(-2));
        // Worked after assignment: the work resets it.
        expect(followUpAgeingBasis({ last_worked_at: day(-1), assigned_at: day(-9) }, NOW)).toEqual(at(-1));
    });

    it("never worked, never assigned: creation", () => {
        expect(followUpAgeingBasis({ created_at: day(-40) }, NOW)).toEqual(at(-40));
        expect(followUpAgeingBasis({}, NOW)).toBeNull();
    });

    it(`a follow-up more than ${FOLLOW_UP_HORIZON_DAYS} days ahead is ignored`, () => {
        const far = day(FOLLOW_UP_HORIZON_DAYS + 5);
        expect(followUpAgeingBasis({ last_worked_at: day(-12), next_follow_up_at: far }, NOW)).toEqual(at(-12));
        expect(followUpPending(far, NOW)).toBe(false);
    });

    it("the SQL twin reads the same columns with the same horizon", () => {
        for (const col of ["last_worked_at", "assigned_at", "next_follow_up_at", "created_at"]) {
            expect(FOLLOW_UP_AGEING_BASIS_TEXT).toContain(`dl.${col}`);
        }
        expect(FOLLOW_UP_AGEING_BASIS_TEXT).toContain(`INTERVAL '${FOLLOW_UP_HORIZON_DAYS} days'`);
        expect(FOLLOW_UP_AGEING_BASIS_TEXT).toMatch(/GREATEST/);
    });
});
