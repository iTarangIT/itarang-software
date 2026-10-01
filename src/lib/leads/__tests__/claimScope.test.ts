import { describe, expect, it } from "vitest";
import { claimsByNumberOnly, isPoolTabFor, parseMobileList } from "@/lib/leads/claimScope";

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
        expect(parseMobileList("98765 43210")).toEqual({ mobiles: ["9876543210"], invalid: [] });
        expect(parseMobileList("+91 9123456789, 09988776655; 9123456789\n12345")).toEqual({
            mobiles: ["9123456789", "9988776655"],
            invalid: ["12345"],
        });
    });
});
