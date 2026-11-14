// ID 233: the "Test lead" reason — who may give it, and that it is never a sales loss.
import { describe, expect, it } from "vitest";

import { LOST_REASON, SALES_LOST_REASONS, TEST_LEAD_ROLES, canGiveLostReason } from "../transitions";

describe("ID 233 test_lead", () => {
    it("is a Lost reason only Admin, Sales Head and CEO may give", () => {
        expect(LOST_REASON).toContain("test_lead");
        expect([...TEST_LEAD_ROLES].sort()).toEqual(["admin", "ceo", "sales_head"]);
        for (const role of ["admin", "sales_head", "ceo"]) expect(canGiveLostReason("test_lead", role)).toBe(true);
        for (const role of ["asm", "inside_sales_rep", "partner", null]) expect(canGiveLostReason("test_lead", role)).toBe(false);
        expect(canGiveLostReason("price_high", "asm")).toBe(true);
    });
    it("is not a sales loss (nor is the onboarding drop-out)", () => {
        expect(SALES_LOST_REASONS).not.toContain("test_lead");
        expect(SALES_LOST_REASONS).not.toContain("onboarding_dropout");
        expect(SALES_LOST_REASONS).toContain("price_high");
    });
});
