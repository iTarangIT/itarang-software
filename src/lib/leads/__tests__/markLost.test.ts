import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
const { checkMarkLost, deriveClosingRole, HighImpactUnconfirmedError, LostNotesRequiredError } = await import("../markLost");

describe("markLost rules (extracted from the mark-lost route)", () => {
    it("closing role by actor", () => {
        expect(deriveClosingRole("asm")).toBe("asm_visit");
        expect(deriveClosingRole("admin")).toBe("admin");
        expect(deriveClosingRole("inside_sales_rep")).toBe("is_phone");
        expect(deriveClosingRole("partner")).toBe("is_phone");
    });

    it("'other' needs notes", () => {
        expect(() => checkMarkLost({ reason: "other" })).toThrow(LostNotesRequiredError);
        expect(() => checkMarkLost({ reason: "other", notes: "  " })).toThrow(LostNotesRequiredError);
        expect(() => checkMarkLost({ reason: "other", notes: "moved city" })).not.toThrow();
    });

    it("the four high-impact reasons need explicit confirmation; the rest don't", () => {
        for (const r of ["business_closed", "duplicate_lead", "rejected_by_us_credit", "rejected_by_us_geography"] as const) {
            expect(() => checkMarkLost({ reason: r }), r).toThrow(HighImpactUnconfirmedError);
            expect(() => checkMarkLost({ reason: r, confirmedHighImpact: true }), r).not.toThrow();
        }
        for (const r of ["price_high", "not_interested"] as const) expect(() => checkMarkLost({ reason: r })).not.toThrow();
    });
});
