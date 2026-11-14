// ID 215 (14 Nov): CEO and dashboard screens show words, never codes.
import { describe, expect, it } from "vitest";

import { roleLabel } from "@/lib/admin/reportHelpers";
import { lostReasonWords } from "@/lib/leads/lostReasons";
import { invoiceStatusLabel } from "@/lib/sales/invoiceStatusLabel";

describe("ID 215 words", () => {
    it("roles", () => {
        expect(roleLabel("inside_sales_rep")).toBe("Inside Sales");
        expect(roleLabel("finance_controller")).toBe("Finance");
        expect(roleLabel("field_lead")).toBe("Field lead");
        expect(roleLabel(null)).toBe("—");
    });
    it("invoice status", () => {
        expect(invoiceStatusLabel("partially_paid")).toBe("Partly paid");
        expect(invoiceStatusLabel("credit_note")).toBe("Credit note");
        expect(invoiceStatusLabel(null)).toBe("No status");
        expect(invoiceStatusLabel("on_hold")).toBe("On hold");
    });
    it("lost reasons", () => {
        expect(lostReasonWords("price_high")).toBe("Price too high");
        expect(lostReasonWords("rejected_by_us_credit")).toBe("Rejected by us: credit");
        expect(lostReasonWords("other")).toBe("Other");
        expect(lostReasonWords("some_new_reason")).toBe("Some new reason");
        expect(lostReasonWords(null)).toBe("");
    });
});
