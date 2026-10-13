import { describe, expect, it } from "vitest";
import { ecofyStageSummary } from "../stageSummary";

describe("ID 51 #2 — Ecofy dashboard tile", () => {
    it("orders by pipeline (S0 … S8, Closed, unknown last), labels, and totals", () => {
        const s = ecofyStageSummary(
            [
                { stage: "CLOSED", n: 2 },
                { stage: "S8", n: "7" },
                { stage: "S1", n: 9 },
                { stage: null, n: 1 },
                { stage: "S0", n: 3 },
                { stage: "S6", n: 4 },
            ],
            "9",
        );
        expect(s.byStage.map((r) => r.stage)).toEqual(["S0", "S1", "S6", "S8", "CLOSED", "UNKNOWN"]);
        expect(s.byStage.find((r) => r.stage === "S1")?.label).toBe("Pickup queue");
        expect(s.byStage.find((r) => r.stage === "UNKNOWN")?.label).toBe("No stage");
        expect(s.total).toBe(26);
        // open = not S0, not CLOSED (no-stage counts as open, like ecofyCounts)
        expect(s.open).toBe(21);
        expect(s.queue).toBe(9);
        expect(s.available).toBe(true);
    });

    it("merges blank stages, drops zero rows, and is empty-safe", () => {
        const s = ecofyStageSummary([{ stage: "", n: 1 }, { stage: "  ", n: 2 }, { stage: "S2", n: 0 }], 0);
        expect(s.byStage).toEqual([{ stage: "UNKNOWN", label: "No stage", count: 3 }]);
        expect(ecofyStageSummary([], 0)).toMatchObject({ total: 0, open: 0, queue: 0, byStage: [] });
    });
});
