import { describe, expect, it } from "vitest";
import {
    CLAIM_SEARCH_MAX_NUMBERS,
    LIST_SEARCH_MAX_NUMBERS,
    claimsByNumberOnly,
    isPoolTabFor,
    numberSearchMode,
    parseMobileList,
} from "@/lib/leads/claimScope";

describe("claimScope", () => {
    it("reps claim by number only; managers keep the pool", () => {
        expect(claimsByNumberOnly("asm")).toBe(true);
        expect(claimsByNumberOnly("inside_sales_rep")).toBe(true);
        expect(claimsByNumberOnly("sales_head")).toBe(false);
        expect(isPoolTabFor("asm", "territory")).toBe(true);
        expect(isPoolTabFor("inside_sales_rep", "unassigned")).toBe(true);
        expect(isPoolTabFor("sales_head", "territory")).toBe(false);
        expect(isPoolTabFor("asm", "my_visits")).toBe(false);
    });

    it("parses single and comma-separated mobiles", () => {
        expect(parseMobileList("98765 43210")).toEqual({ mobiles: ["9876543210"], invalid: [], overLimit: 0 });
        expect(parseMobileList("+91 9123456789, 09988776655; 9123456789\n12345")).toEqual({
            mobiles: ["9123456789", "9988776655"],
            invalid: ["12345"],
            overLimit: 0,
        });
    });

    it("reads numbers pasted without commas (ID 46)", () => {
        const two = { mobiles: ["9876543210", "9123456789"], invalid: [], overLimit: 0 };
        expect(parseMobileList("9876543210 9123456789")).toEqual(two);
        expect(parseMobileList("9876543210\r\n9123456789")).toEqual(two);
        expect(parseMobileList("9876543210\t9123456789")).toEqual(two);
        expect(parseMobileList("98765432109123456789")).toEqual(two);
        expect(parseMobileList("98765 43210 91234 56789")).toEqual(two);
        expect(parseMobileList("+91 9876543210 +91 9123456789")).toEqual(two);
        expect(parseMobileList("9876543210 12345")).toEqual({ mobiles: ["9876543210"], invalid: ["12345"], overLimit: 0 });
        // Not numbers at all: reported whole, never guessed at.
        expect(parseMobileList("12345 678")).toEqual({ mobiles: [], invalid: ["12345 678"], overLimit: 0 });
        expect(parseMobileList("12345678901234567890")).toEqual({
            mobiles: [],
            invalid: ["12345678901234567890"],
            overLimit: 0,
        });
    });

    it("counts the numbers dropped past the cap", () => {
        const many = Array.from({ length: 60 }, (_, i) => `98765${String(10000 + i)}`).join(",");
        const claim = parseMobileList(many);
        expect(claim.mobiles).toHaveLength(CLAIM_SEARCH_MAX_NUMBERS);
        expect(claim.overLimit).toBe(60 - CLAIM_SEARCH_MAX_NUMBERS);
        // The leads list takes more than the claim search.
        const list = numberSearchMode(many);
        expect(list?.mobiles).toHaveLength(60);
        expect(list?.overLimit).toBe(0);
        const big = Array.from({ length: LIST_SEARCH_MAX_NUMBERS + 5 }, (_, i) => `98765${String(10000 + i)}`).join(",");
        expect(numberSearchMode(big)?.overLimit).toBe(5);
    });

    it("treats a search box of numbers as a number search (ID 46)", () => {
        expect(numberSearchMode("9876543210")).toEqual({ mobiles: ["9876543210"], invalid: [], overLimit: 0 });
        expect(numberSearchMode("9876543210,")).toEqual({ mobiles: ["9876543210"], invalid: [], overLimit: 0 });
        expect(numberSearchMode("+91 98765-43210, 12345")).toEqual({
            mobiles: ["9876543210"],
            invalid: ["12345"],
            overLimit: 0,
        });
        expect(numberSearchMode("9876543210 9123456789")?.mobiles).toEqual(["9876543210", "9123456789"]);
        // A partial number or a name stays a text search.
        expect(numberSearchMode("98765")).toBeNull();
        expect(numberSearchMode("Sharma Batteries, 9876543210")).toBeNull();
        expect(numberSearchMode("")).toBeNull();
    });
});
