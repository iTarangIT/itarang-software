import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/dashboard/revenueSource", () => ({ drillDownRows: vi.fn() }));

import { monthWindow, reconcile, type ReconDoc } from "@/lib/sales/gstr1Reconcile";

const doc = (key: string, total: number, credit_note = false): ReconDoc => ({ key, number: key, date: "2026-09-10", total, credit_note });

describe("GSTR-1 reconciliation (ID 71)", () => {
    it("a closed month that agrees reports no differences", () => {
        const r = reconcile("2026-09", [doc("A1", 1000), doc("A2", 500), doc("CN1", -200, true)], [doc("A1", 1000), doc("A2", 500.4), doc("CN1", 200, true)]);
        expect(r.difference).toBeCloseTo(-0.4);
        expect(r.matched).toBe(3);
        expect(r.missing_in_crm).toEqual([]);
        expect(r.missing_in_gstr1).toEqual([]);
        expect(r.amount_mismatch).toEqual([]);
    });

    it("lists every difference: missing on either side and amounts that disagree", () => {
        const r = reconcile("2026-09", [doc("A1", 1000), doc("A3", 300)], [doc("A1", 1180), doc("A2", 500)]);
        expect(r.crm_total).toBe(1300);
        expect(r.gstr1_total).toBe(1680);
        expect(r.difference).toBe(-380);
        expect(r.missing_in_crm.map((d) => d.key)).toEqual(["A2"]);
        expect(r.missing_in_gstr1.map((d) => d.key)).toEqual(["A3"]);
        expect(r.amount_mismatch).toEqual([{ number: "A1", crm: 1000, gstr1: 1180, difference: -180 }]);
    });

    it("month windows roll over the year", () => {
        expect(monthWindow("2026-12")).toEqual({ from: "2026-12-01", toExcl: "2027-01-01" });
        expect(() => monthWindow("2026-9")).toThrow();
    });
});
