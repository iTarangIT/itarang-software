import { describe, expect, it } from "vitest";

import { ANALYSES, ANALYSIS_IDS, gridCell, isGridAnalysis } from "@/lib/reports/analysesShared";

// A22–A24 — the three grid analyses are registered and print their cells.

describe("grid analyses", () => {
    it("each id has a card, and the three new ones are grid analyses", () => {
        expect(ANALYSES.map((a) => a.id).sort()).toEqual([...ANALYSIS_IDS].sort());
        for (const id of ["cohorts", "turnaround", "ai_outcomes"]) expect(isGridAnalysis(id)).toBe(true);
        expect(isGridAnalysis("meetings")).toBe(false);
    });

    it("prints counts, days and shares; blanks as —", () => {
        expect(gridCell(12345, "count")).toBe("12,345");
        expect(gridCell(2.345, "days")).toBe("2.3");
        expect(gridCell(33.333, "pct")).toBe("33.3%");
        expect(gridCell(null, "pct")).toBe("—");
        expect(gridCell("2026-10", "text")).toBe("2026-10");
    });
});
