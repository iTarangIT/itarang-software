import { describe, expect, it } from "vitest";

import { isSingleWindow, mergeWindowParts, teamWindows, type WindowPart } from "../teamWindows";
import { orderByTeam } from "../teamRules";

describe("teamWindows (ID 156: each member for the dates they were in the team)", () => {
    it("everyone in the team all range long is one window", () => {
        const w = teamWindows("m", [{ user_id: "a", effective_from: "2026-01-01", effective_to: null }], "2026-10-01", "2026-10-13");
        expect(w).toEqual([{ from: "2026-10-01", to: "2026-10-13", ids: ["m", "a"] }]);
        expect(isSingleWindow(w, "2026-10-01", "2026-10-13")).toBe(true);
    });

    it("a member who joined and one who left mid-range get their own days (effective_to is exclusive)", () => {
        const w = teamWindows(
            "m",
            [
                { user_id: "a", effective_from: "2026-10-10", effective_to: null },
                { user_id: "b", effective_from: "2026-09-01", effective_to: "2026-10-06" },
            ],
            "2026-10-01",
            "2026-10-13",
        );
        expect(w).toEqual([
            { from: "2026-10-01", to: "2026-10-05", ids: ["b"] },
            { from: "2026-10-01", to: "2026-10-13", ids: ["m"] },
            { from: "2026-10-10", to: "2026-10-13", ids: ["a"] },
        ]);
    });

    it("a line outside the range adds nobody", () => {
        const w = teamWindows("m", [{ user_id: "a", effective_from: "2026-11-01", effective_to: null }], "2026-10-01", "2026-10-13");
        expect(w).toEqual([{ from: "2026-10-01", to: "2026-10-13", ids: ["m"] }]);
    });
});

const part = (days: number, visits: number, bucket: string, avg: number): WindowPart => ({
    days,
    series: [{ bucket, visits, unique_visits: visits, new_visits: 0, fresh_visits: 0, calls: 0 }],
    averages: { days_in_range: days, avg_visits_per_day: avg, avg_unique_per_day: avg, avg_new_per_day: 0, avg_fresh_per_day: 0, avg_calls_per_day: 0 },
    totals: { visits, fresh_visits: 0, unique_visits: visits, new_visits: 0, calls: 0, dealers_called: 0, converted: 1, new_hot: 0, hot_converted: 0 },
    outcome: { quotes_issued: 0, quote_revisions: 0, revenue: 100, batteries_to_dealers: 2, battery_lines: { invoices: 1, with_lines: 1 }, kyc_submitted: 0 },
});

describe("mergeWindowParts", () => {
    it("sums totals, outcome and series by bucket; averages re-weighted to the whole range", () => {
        const m = mergeWindowParts([part(10, 20, "2026-10-01", 2), part(5, 5, "2026-10-01", 1)], 10);
        expect(m.totals.visits).toBe(25);
        expect(m.totals.converted).toBe(2);
        expect(m.outcome.revenue).toBe(200);
        expect(m.outcome.battery_lines).toEqual({ invoices: 2, with_lines: 2 });
        expect(m.series).toEqual([{ bucket: "2026-10-01", visits: 25, unique_visits: 25, new_visits: 0, fresh_visits: 0, calls: 0 }]);
        // (2 × 10 + 1 × 5) / 10
        expect(m.averages.avg_visits_per_day).toBe(2.5);
        expect(m.averages.days_in_range).toBe(10);
    });
});

describe("orderByTeam", () => {
    it("lists each member right under their manager, the rest after", () => {
        const list = [{ spoc_id: "a" }, { spoc_id: "m" }, { spoc_id: "x" }, { spoc_id: "b" }];
        const out = orderByTeam(list, new Map([["a", "m"], ["b", "m"], ["z", "x"]]));
        expect(out.map((p) => `${p.member ? "↳" : ""}${p.spoc_id}`)).toEqual(["m", "↳a", "↳b", "x"]);
    });

    it("a member whose manager is not on the list stays as is", () => {
        const out = orderByTeam([{ spoc_id: "a" }], new Map([["a", "gone"]]));
        expect(out).toEqual([{ spoc_id: "a", member: false }]);
    });
});
