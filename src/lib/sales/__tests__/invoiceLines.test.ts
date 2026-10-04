import { describe, expect, it } from "vitest";
import { classifyHsn, itemKey, normalizeHsn, parseAmount } from "@/lib/sales/invoiceLines";

describe("invoice line classification (ID 39)", () => {
    it("8507 is a battery, 850440 a charger, anything else other", () => {
        expect(classifyHsn("8507")).toBe("battery");
        expect(classifyHsn("8507.60.00")).toBe("battery");
        expect(classifyHsn(85076000)).toBe("battery");
        expect(classifyHsn("8504.40")).toBe("charger");
        expect(classifyHsn("85044090")).toBe("charger");
        expect(classifyHsn("8504.31")).toBe("other");
        expect(classifyHsn("")).toBe("other");
        expect(classifyHsn(null)).toBe("other");
    });
    it("normalises HSN to digits", () => {
        expect(normalizeHsn(" 8507.60 ")).toBe("850760");
        expect(normalizeHsn("85")).toBeNull();
    });
    it("item keys ignore case and spacing", () => {
        expect(itemKey("  LFP  51.2V 100Ah ")).toBe("lfp 51.2v 100ah");
    });
    it("parses Indian-formatted amounts", () => {
        expect(parseAmount("1,23,456.50")).toBe(123456.5);
        expect(parseAmount("₹ 500")).toBe(500);
        expect(parseAmount("(250)")).toBe(-250);
        expect(parseAmount(42)).toBe(42);
        expect(parseAmount("")).toBeNull();
        expect(parseAmount("abc")).toBeNull();
    });
});
