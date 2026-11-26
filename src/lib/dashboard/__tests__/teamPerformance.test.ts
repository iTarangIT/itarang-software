import { describe, expect, it } from "vitest";

import {
    conversionPct,
    inSegment,
    monthLabel,
    monthRange,
    personTargetStatus,
    previousMonth,
    recentMonths,
    rollupTeamTargets,
    segmentOf,
    sumCounts,
    ZERO_COUNTS,
    type TargetLike,
} from "../teamPerformanceRules";
import { peopleSheet, teamPerformanceSheets } from "../teamPerformanceReport";
import type { TeamPerformance } from "../teamPerformance";

const row = (over: Partial<TargetLike>): TargetLike => ({
    user_id: "u1",
    metric: "dealer_visits",
    metric_label: "Dealer visits",
    status: "accepted",
    final_target: 30,
    kind: "count",
    pushed_at: "2026-11-02T05:00:00.000Z",
    accepted_at: "2026-11-02T06:00:00.000Z",
    hours_since_push_unaccepted: null,
    correction_open: false,
    progress: { actual: 10, mtd_target: 20, pct_of_mtd: 50, monthly_target: 30 },
    ...over,
});

describe("segments", () => {
    it("splits field / inside / other like the dashboard's Team control", () => {
        expect(segmentOf("ASM")).toBe("field");
        expect(segmentOf("sales_manager")).toBe("field");
        expect(segmentOf("inside_sales_rep")).toBe("inside");
        expect(segmentOf("sales_head")).toBe("other");
        expect(inSegment("asm", "inside")).toBe(false);
        expect(inSegment("asm", "all")).toBe(true);
    });
});

describe("conversionPct", () => {
    it("is converted ÷ closed, null when nothing closed", () => {
        expect(conversionPct(0, 0)).toBeNull();
        expect(conversionPct(1, 3)).toBe(25);
        expect(conversionPct(2, 0)).toBe(100);
    });
});

describe("sumCounts", () => {
    it("adds every count", () => {
        const s = sumCounts([
            { ...ZERO_COUNTS, visits: 2, hot: 1, revenue: 100 },
            { ...ZERO_COUNTS, visits: 3, cold: 4, revenue: 50 },
        ]);
        expect(s.visits).toBe(5);
        expect(s.hot).toBe(1);
        expect(s.cold).toBe(4);
        expect(s.revenue).toBe(150);
    });
});

describe("personTargetStatus — why a target does or does not show", () => {
    it("no rows → No target for the month", () => {
        const s = personTargetStatus([], "2026-11");
        expect(s.state).toBe("none");
        expect(s.detail).toContain("Nov 2026");
    });
    it("a CEO draft is not visible → still none", () => {
        expect(personTargetStatus([row({ status: "draft" })], "2026-11").state).toBe("none");
    });
    it("posted but not pushed → with the Sales Head", () => {
        const s = personTargetStatus([row({ status: "pending_approval", pushed_at: null, accepted_at: null })], "2026-11");
        expect(s.state).toBe("with_sales_head");
        expect(s.in_force).toBe(0);
        expect(s.with_sales_head).toBe(1);
    });
    it("pushed, not accepted → awaiting acceptance with hours", () => {
        const s = personTargetStatus([row({ status: "pushed", accepted_at: null, hours_since_push_unaccepted: 50 })], "2026-11");
        expect(s.state).toBe("awaiting_acceptance");
        expect(s.oldest_unaccepted_h).toBe(50);
        expect(s.detail).toContain("50 h");
    });
    it("some accepted → partly accepted", () => {
        const s = personTargetStatus([row({}), row({ metric: "revenue", status: "pushed", accepted_at: null })], "2026-11");
        expect(s.state).toBe("partly_accepted");
        expect(s.label).toBe("1 of 2 accepted");
    });
    it("all accepted, plus one not pushed yet", () => {
        const s = personTargetStatus([row({}), row({ metric: "revenue", status: "pending_approval" })], "2026-11");
        expect(s.state).toBe("accepted");
        expect(s.detail).toContain("1 more posted but not pushed");
    });
    it("an open correction wins", () => {
        expect(personTargetStatus([row({ status: "pushed", correction_open: true })], "2026-11").state).toBe("correction_asked");
    });
    it("removed rows are ignored", () => {
        expect(personTargetStatus([row({ status: "removed" })], "2026-11").state).toBe("none");
    });
});

describe("rollupTeamTargets", () => {
    it("adds targets in force and the same people's actuals, per metric", () => {
        const rows = [
            row({ user_id: "a" }),
            row({ user_id: "b", status: "pushed", progress: { actual: 5, mtd_target: 10, pct_of_mtd: 50, monthly_target: 15 } }),
            row({ user_id: "c", status: "pending_approval" }), // not in force
            row({ user_id: "z" }), // not on the team
        ];
        const [r] = rollupTeamTargets(rows, new Set(["a", "b", "c"]));
        expect(r.people).toBe(2);
        expect(r.monthly_target).toBe(45);
        expect(r.mtd_target).toBe(30);
        expect(r.actual).toBe(15);
        expect(r.pct).toBe(50);
    });
    it("not measured stays null, never 0%", () => {
        const [r] = rollupTeamTargets([row({ progress: { actual: null, mtd_target: 10, pct_of_mtd: null, monthly_target: 20 } })], new Set(["u1"]));
        expect(r.actual).toBeNull();
        expect(r.pct).toBeNull();
    });
});

describe("monthly review ranges", () => {
    it("a past month is 1st to month end", () => {
        expect(monthRange("2026-10", "2026-11-26")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
        expect(monthRange("2024-02", "2026-11-26")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    });
    it("the running month stops at today", () => {
        expect(monthRange("2026-11", "2026-11-26")).toEqual({ from: "2026-11-01", to: "2026-11-26" });
    });
    it("previous / recent months cross the year", () => {
        expect(previousMonth("2026-01-15")).toBe("2025-12");
        expect(recentMonths("2026-02-10", 3)).toEqual(["2026-02", "2026-01", "2025-12"]);
        expect(monthLabel("2026-11")).toBe("Nov 2026");
    });
});

describe("team report sheets", () => {
    const person = {
        ...ZERO_COUNTS,
        visits: 4,
        hot: 2,
        dealers_onboarded: 1,
        converted: 1,
        lost: 1,
        user_id: "a",
        name: "Asha",
        role: "asm",
        segment: "field" as const,
        manager: "Ravi",
        conversion_pct: 50,
        target_status: personTargetStatus([row({ user_id: "a" })], "2026-11"),
        targets: [
            {
                metric: "dealer_visits",
                label: "Dealer visits",
                kind: "count" as const,
                status: "accepted",
                final_target: 30,
                mtd_target: 20,
                actual: 10,
                pct: 50,
                pushed_at: null,
                accepted_at: null,
            },
        ],
    };
    const data: TeamPerformance = {
        filters: { from: "2026-11-01", to: "2026-11-26", state: null, city: null, business_type: null, team: "all" },
        as_of: "2026-11-26",
        target_month: "2026-11",
        working_days: { total: 25, elapsed: 22 },
        team: { ...sumCounts([person]), conversion_pct: 50, people: 1 },
        team_targets: rollupTeamTargets([row({ user_id: "a" })], new Set(["a"])),
        target_states: { none: 0, with_sales_head: 0, awaiting_acceptance: 0, correction_asked: 0, accepted: 1, partly_accepted: 0 },
        people: [person],
    };
    it("People has one row per person plus the team total, same width as the header", () => {
        const s = peopleSheet(data);
        expect(s.rows).toHaveLength(2);
        for (const r of s.rows) expect(r).toHaveLength(s.headers.length);
        expect(s.rows[1][0]).toBe("Team total (1)");
        expect(s.rows[0][s.headers.indexOf("Dealers onboarded")]).toBe(1);
        expect(s.rows[0][s.headers.indexOf("Target status")]).toBe("Accepted");
    });
    it("the workbook has Summary, People and Targets", () => {
        const sheets = teamPerformanceSheets(data);
        expect(sheets.map((s) => s.name)).toEqual(["Summary", "People", "Targets"]);
        expect(sheets[2].rows[0]).toContain("Dealer visits");
    });
});
