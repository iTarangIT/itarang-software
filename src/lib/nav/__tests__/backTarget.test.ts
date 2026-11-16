import { describe, expect, it } from "vitest";
import { previousPage, pushVisit, roleHome } from "../backTarget";

describe("ID 232 back target", () => {
    it("returns the filtered list the lead was opened from", () => {
        let s: string[] = [];
        s = pushVisit(s, "/leads");
        s = pushVisit(s, "/leads?intent=hot"); // filter changed in place
        s = pushVisit(s, "/inside-sales/lead/DL-1");
        expect(s).toEqual(["/leads?intent=hot", "/inside-sales/lead/DL-1"]);
        expect(previousPage(s, "/inside-sales/lead/DL-1")).toBe("/leads?intent=hot");
    });
    it("skips the lead page's own query changes", () => {
        const s = ["/asm?tab=visits&from=2026-11-16", "/asm/lead/DL-2", "/asm/lead/DL-2?quote=Q1"];
        expect(previousPage(pushVisit(s.slice(0, 2), s[2]), "/asm/lead/DL-2")).toBe("/asm?tab=visits&from=2026-11-16");
    });
    it("is null in a fresh tab, so Back goes home", () => {
        expect(previousPage(pushVisit([], "/asm/lead/DL-3"), "/asm/lead/DL-3")).toBeNull();
        expect(roleHome("sales_head")).toBe("/sales-head");
        expect(roleHome("asm")).toBe("/asm");
        expect(roleHome("weird")).toBe("/");
    });
});
