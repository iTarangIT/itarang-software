import { describe, expect, it } from "vitest";
import {
    checkClaimDays,
    dayMissingNote,
    isExpenseCeo,
    mayReadTravelProof,
    needsTravelProof,
    proofSummary,
    verdictFor,
} from "@/lib/expenses/travelProof";

describe("needsTravelProof (ID 197)", () => {
    it("only Travel and Vehicle/Fuel", () => {
        expect(needsTravelProof("Travel")).toBe(true);
        expect(needsTravelProof("Vehicle/Fuel")).toBe(true);
        expect(needsTravelProof("Office")).toBe(false);
        expect(needsTravelProof(null)).toBe(false);
    });
});

describe("verdictFor", () => {
    it("supported only with a verified visit", () => {
        expect(verdictFor([])).toBe("not_supported");
        expect(verdictFor([{ verified: false }])).toBe("not_supported");
        expect(verdictFor([{ verified: false }, { verified: true }])).toBe("supported");
    });
});

describe("checkClaimDays", () => {
    const today = "2026-10-29";
    it("needs a day", () => expect(checkClaimDays([], today).ok).toBe(false));
    it("today and 31 days back are fine, sorted", () => {
        const r = checkClaimDays(["2026-10-29", "2026-09-28"], today);
        expect(r).toEqual({ ok: true, days: ["2026-09-28", "2026-10-29"] });
    });
    it("refuses the future, older than 31 days, repeats and non-dates", () => {
        expect(checkClaimDays(["2026-10-30"], today).ok).toBe(false);
        expect(checkClaimDays(["2026-09-27"], today).ok).toBe(false);
        expect(checkClaimDays(["2026-10-01", "2026-10-01"], today).ok).toBe(false);
        expect(checkClaimDays(["2026-02-30"], today).ok).toBe(false);
        expect(checkClaimDays(["yesterday"], today).ok).toBe(false);
    });
});

describe("dayMissingNote", () => {
    it("a Not supported day needs a note", () => {
        expect(dayMissingNote([{ day: "a", verdict: "supported" }])).toBeNull();
        expect(dayMissingNote([{ day: "a", verdict: "not_supported", note: "  " }])).toBe("a");
        expect(dayMissingNote([{ day: "a", verdict: "not_supported", note: "client meeting" }])).toBeNull();
    });
});

describe("proofSummary", () => {
    it("reads N of M days supported", () => {
        expect(proofSummary([])).toBe("");
        expect(proofSummary([{ verdict: "supported" }])).toBe("1 of 1 day supported");
        expect(proofSummary([{ verdict: "supported" }, { verdict: "not_supported" }])).toBe("1 of 2 days supported");
    });
});

describe("who reads the Day evidence", () => {
    it("the CEO and the submitter only", () => {
        expect(isExpenseCeo({ role: "ceo" })).toBe(true);
        expect(isExpenseCeo({ role: "admin" })).toBe(false);
        expect(mayReadTravelProof({ id: "u1", role: "asm" }, "u1")).toBe(true);
        expect(mayReadTravelProof({ id: "u2", role: "asm" }, "u1")).toBe(false);
        expect(mayReadTravelProof({ id: "c", role: "ceo" }, "u1")).toBe(true);
    });
});
