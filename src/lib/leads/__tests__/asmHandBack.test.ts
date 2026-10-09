// ID 121 — handing a lead Awaiting field visit back to an ISR / partner.
import { describe, expect, it } from "vitest";
import { handBackBlockReason, isHandBack, releaseNote } from "../asmHandBack";

describe("isHandBack", () => {
    it("is a Transferred_to_ASM lead going to an ISR or partner", () => {
        expect(isHandBack("Transferred_to_ASM", "inside_sales_rep")).toBe(true);
        expect(isHandBack("Transferred_to_ASM", "partner")).toBe(true);
    });
    it("is not an ASM-to-ASM swap, another role, or a lead that is not awaiting a visit", () => {
        expect(isHandBack("Transferred_to_ASM", "asm")).toBe(false);
        expect(isHandBack("Transferred_to_ASM", "sales_head")).toBe(false);
        expect(isHandBack("Transferred_to_ASM", null)).toBe(false);
        expect(isHandBack("Under_Discussion", "inside_sales_rep")).toBe(false);
        expect(isHandBack(null, "inside_sales_rep")).toBe(false);
    });
});

describe("handBackBlockReason", () => {
    it("goes ahead when nothing is booked", () => {
        expect(handBackBlockReason(null)).toBeNull();
    });
    it("names the ASM and the date, and says what to do", () => {
        expect(handBackBlockReason({ scheduledDate: "2026-10-12", asmName: "Suresh" })).toBe(
            "Suresh has a visit booked for 12 Oct. Cancel or complete the visit first, then hand the lead back.",
        );
    });
    it("falls back to 'The ASM' with no name", () => {
        expect(handBackBlockReason({ scheduledDate: "2026-10-09", asmName: "  " })).toMatch(/^The ASM has a visit booked for 9 Oct\./);
    });
});

describe("releaseNote", () => {
    it("counts the closed visits", () => {
        expect(releaseNote(0)).toBe("ASM unlinked.");
        expect(releaseNote(1)).toBe("ASM unlinked; 1 open visit closed.");
        expect(releaseNote(2)).toBe("ASM unlinked; 2 open visits closed.");
    });
});
