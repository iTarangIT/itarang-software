import { describe, it, expect } from "vitest";
import {
    looksLikeTotalRow,
    parseSheetAmount,
    parseSheetDate,
} from "./extractCostingSheet";

// E-214. These are the deterministic halves of the costing-sheet importer —
// the model only ever reports the sheet's LAYOUT, and everything below turns
// that layout into money. A bug here silently misstates spend on the CEO
// dashboard, so it is worth pinning down without burning a model call.

describe("parseSheetAmount", () => {
    it("passes through numeric cells", () => {
        expect(parseSheetAmount(1200)).toBe(1200);
        expect(parseSheetAmount(0)).toBe(0);
    });

    it("reads Indian digit grouping", () => {
        expect(parseSheetAmount("1,20,000.50")).toBe(120000.5);
        expect(parseSheetAmount("1,200")).toBe(1200);
    });

    it("strips currency symbols and codes", () => {
        expect(parseSheetAmount("₹ 45,000")).toBe(45000);
        expect(parseSheetAmount("Rs. 900")).toBe(900);
        expect(parseSheetAmount("INR 2,500")).toBe(2500);
    });

    it("reads the accounting negative", () => {
        // Credit notes and reversals are parenthesised, not signed.
        expect(parseSheetAmount("(500)")).toBe(-500);
    });

    it("returns null rather than guessing", () => {
        expect(parseSheetAmount("")).toBeNull();
        expect(parseSheetAmount(null)).toBeNull();
        expect(parseSheetAmount(undefined)).toBeNull();
        expect(parseSheetAmount("N/A")).toBeNull();
        expect(parseSheetAmount("-")).toBeNull();
    });
});

describe("parseSheetDate", () => {
    it("reads ISO", () => {
        expect(parseSheetDate("2026-03-14")).toBe("2026-03-14");
    });

    it("reads dd/mm/yyyy as day-first", () => {
        // Indian books: 03/04 is 3 April, never 4 March.
        expect(parseSheetDate("14/03/2026")).toBe("2026-03-14");
        expect(parseSheetDate("03-04-2026")).toBe("2026-04-03");
    });

    it("expands a two-digit year", () => {
        expect(parseSheetDate("14-03-26")).toBe("2026-03-14");
    });

    it("reads an Excel serial number", () => {
        // xlsx stores dates as days since 1899-12-30 when cellDates is off.
        expect(parseSheetDate(45000)).toBe("2023-03-15");
    });

    it("passes a real Date through", () => {
        expect(parseSheetDate(new Date(Date.UTC(2026, 2, 14)))).toBe("2026-03-14");
    });

    it("rejects a date JS would silently roll forward", () => {
        // new Date(2024, 1, 31) is 2 March. Accepting it would file the expense
        // in the wrong month.
        expect(parseSheetDate("2024-02-31")).toBeNull();
    });

    it("does not mistake a small number for a date", () => {
        // A quantity column must never be read as a date.
        expect(parseSheetDate(12)).toBeNull();
        expect(parseSheetDate(999)).toBeNull();
    });

    it("returns null for empty cells", () => {
        expect(parseSheetDate("")).toBeNull();
        expect(parseSheetDate(null)).toBeNull();
    });
});

describe("looksLikeTotalRow", () => {
    // Importing a sheet's own total alongside its line items double-counts the
    // whole sheet. amountCol = 2 throughout.
    it("catches summary rows wherever the label sits", () => {
        expect(looksLikeTotalRow(["Grand Total", "", 500000], 2)).toBe(true);
        expect(looksLikeTotalRow(["", "Total", 500000], 2)).toBe(true);
        expect(looksLikeTotalRow(["Sub Total", "", 9000], 2)).toBe(true);
        expect(looksLikeTotalRow(["SUBTOTAL", "", 9000], 2)).toBe(true);
        expect(looksLikeTotalRow(["Net Total", "", 9000], 2)).toBe(true);
    });

    it("keeps ordinary cost lines", () => {
        expect(looksLikeTotalRow(["Acme Ltd", "Freight", 9000], 2)).toBe(false);
    });

    it("keeps a description that merely contains the word", () => {
        // "Totalising flow meter" is a real thing somebody bought.
        expect(looksLikeTotalRow(["Acme", "Totalising flow meter", 9000], 2)).toBe(false);
    });

    it("never triggers on the amount column itself", () => {
        // A large amount is not evidence of a total row.
        expect(looksLikeTotalRow(["Acme", "Freight", 500000], 2)).toBe(false);
    });
});
