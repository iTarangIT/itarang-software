import { describe, expect, it } from "vitest";
<<<<<<< HEAD
import { cleanInvoiceLines, itemKey, linesAddUp, lineTypeFromHsn, parseVoltAh } from "@/lib/sales/invoiceLines";

describe("invoice lines (ID 72)", () => {
  it("classifies a line by HSN, not by name", () => {
    expect(lineTypeFromHsn("85076000")).toBe("battery");
    expect(lineTypeFromHsn("8507")).toBe("battery");
    expect(lineTypeFromHsn("8504.40.30")).toBe("charger");
    expect(lineTypeFromHsn("85481020")).toBe("scrap");
    expect(lineTypeFromHsn("8549")).toBe("scrap");
    expect(lineTypeFromHsn("9987")).toBe("other");
    expect(lineTypeFromHsn("")).toBeNull();
    expect(lineTypeFromHsn(null)).toBeNull();
  });

  it("folds an item name to one mapping key", () => {
    expect(itemKey("  51.2V / 105AH  Li-Ion Battery ")).toBe("51.2v 105ah li ion battery");
    expect(itemKey("51.2V 105AH LI-ION BATTERY")).toBe("51.2v 105ah li ion battery");
    expect(itemKey(null)).toBe("");
  });

  it("reads voltage and Ah from an item name", () => {
    expect(parseVoltAh("Lithium Battery 51.2V 105Ah")).toEqual({ voltage: 51, capacity: 105 });
    expect(parseVoltAh("BAT-61V-153AH-3W")).toEqual({ voltage: 61, capacity: 153 });
    expect(parseVoltAh("Eco Star Charger")).toBeNull();
    expect(parseVoltAh("51V charger 30A")).toBeNull();
  });

  it("keeps only lines that can be costed, rebuilding a missing amount", () => {
    const lines = cleanInvoiceLines([
      { description: "51V 105Ah", hsn_code: "8507 60 00", quantity: 2, rate: 40000, amount: 80000 },
      { description: "Charger", hsn_code: null, quantity: 2, rate: 5000, amount: null },
      { description: "", hsn_code: null, quantity: 1, rate: 1, amount: 1 },
      { description: "Free item", hsn_code: null, quantity: 1, rate: 0, amount: 0 },
      { description: "No quantity", hsn_code: null, quantity: null, rate: 10, amount: 10 },
    ]);
    expect(lines).toEqual([
      { line_no: 1, description: "51V 105Ah", item_key: "51v 105ah", hsn_code: "85076000", quantity: 2, rate: 40000, amount: 80000 },
      { line_no: 2, description: "Charger", item_key: "charger", hsn_code: null, quantity: 2, rate: 5000, amount: 10000 },
    ]);
  });

  it("trusts lines only when they add up to the taxable value", () => {
    const lines = [{ amount: 80000 }, { amount: 10000 }];
    expect(linesAddUp(lines, 90000)).toBe(true);
    expect(linesAddUp(lines, 90001.5)).toBe(true);
    expect(linesAddUp(lines, 90400)).toBe(true); // within 0.5%
    expect(linesAddUp(lines, 95000)).toBe(false);
    expect(linesAddUp(lines, null)).toBe(false);
    expect(linesAddUp([], 90000)).toBe(false);
  });
=======
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
>>>>>>> fac2a80905456e04c4d89ee14f26fdf80ae34f9e
});
