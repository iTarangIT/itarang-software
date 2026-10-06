import { describe, expect, it } from "vitest";
import { batteryReading } from "@/lib/admin/batteryReading";

const o = (batteries: number, lines: { invoices: number; with_lines: number } | null) => ({
    batteries_to_dealers: batteries,
    battery_lines: lines,
});

describe("batteryReading", () => {
    it("no linked invoices in range → a real zero", () => {
        expect(batteryReading(o(0, { invoices: 0, with_lines: 0 }))).toEqual({
            state: "complete",
            value: 0,
            invoices: 0,
            with_lines: 0,
        });
    });

    it("invoices but none has item lines → unknown, never 0", () => {
        const r = batteryReading(o(0, { invoices: 11, with_lines: 0 }));
        expect(r.state).toBe("unknown");
        expect(r.value).toBeNull();
        expect(r.invoices).toBe(11);
    });

    it("some invoices without lines → the count is a floor", () => {
        const r = batteryReading(o(125, { invoices: 11, with_lines: 2 }));
        expect(r).toEqual({ state: "partial", value: 125, invoices: 11, with_lines: 2 });
    });

    it("every invoice has lines → complete", () => {
        expect(batteryReading(o(130, { invoices: 4, with_lines: 4 })).state).toBe("complete");
    });

    it("pre-E-322 fallback (no line coverage) → the number as-is", () => {
        expect(batteryReading(o(7, null))).toEqual({ state: "complete", value: 7, invoices: null, with_lines: null });
    });
});
