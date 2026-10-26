/**
 * Daily Sales email — Blocks B / C / D row shaping (tracker ID 9).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
const {
    BLOCK_B_COLUMNS,
    BLOCK_C_COLUMNS,
    BLOCK_D_COLUMNS,
    NO_OWNER,
    NO_OWNER_KEY,
    REP_NOT_MEASURED,
    blockDRows,
    buildRepBlocks,
    datedTeamGroup,
    outsideManagerBlock,
    repBlockTableRows,
} = await import("../salesDailyBlocks");
const { NOT_MEASURED } = await import("../salesDailyBlockA");

type Spoc = Parameters<typeof blockDRows>[0]["per_spoc"] extends (infer T)[] | null ? T : never;

const spoc = (id: string, name: string, role: string, over: Record<string, number> = {}): Spoc =>
    ({
        spoc_id: id,
        name,
        role,
        totals: {
            visits: 0,
            unique_visits: over.unique_visits ?? 0,
            new_visits: over.new_visits ?? 0,
            calls: over.calls ?? 0,
            dealers_called: over.dealers_called ?? 0,
            converted: over.converted ?? 0,
            new_hot: 0,
            hot_converted: 0,
        },
        outcome: {
            quotes_issued: over.quotes ?? 0,
            quote_revisions: 0,
            revenue: over.revenue ?? 0,
            batteries_to_dealers: 0,
            kyc_submitted: 0,
        },
        interest: {
            ageing_basis: "interest_changed_at",
            rows: [
                { interest_level: "hot", total: over.hot ?? 0, age_0_7: 0, age_8_14: over.hot_old ?? 0, age_15_30: 0, age_30_plus: 0 },
                { interest_level: "warm", total: over.warm ?? 0, age_0_7: 0, age_8_14: 0, age_15_30: 0, age_30_plus: 0 },
                { interest_level: "cold", total: over.cold ?? 0, age_0_7: 0, age_8_14: 0, age_15_30: 0, age_30_plus: 0 },
            ],
        },
    }) as unknown as Spoc;

const noExtras = {
    hot_received: new Map<string, number | null>(),
    hot_handed: new Map<string, number | null>(),
    connected: new Map<string, number | null>(),
    engaged: new Map<string, number | null>(),
    quotes_delivered: new Map<string, number | null>(),
    dealer_approved: new Map<string, number | null>(),
    won: new Map<string, number | null>(),
    limits_passed: new Map<string, number | null>(),
    owner_median_h: new Map<string, number | null>(),
};

describe("Block B (ASM) — one row per rep", () => {
    const y = { per_spoc: [spoc("a1", "Zed", "asm", { unique_visits: 3, quotes: 1, revenue: 150000 }), spoc("i1", "Ira", "inside_sales_rep", { calls: 9 })] };
    const mtd = {
        per_spoc: [
            spoc("a1", "Zed", "asm", { unique_visits: 40, new_visits: 7, quotes: 6, converted: 2, revenue: 2500000 }),
            spoc("a2", "Amy", "asm", { unique_visits: 10 }),
            spoc("i1", "Ira", "inside_sales_rep", { calls: 210 }),
        ],
    };
    const extras = {
        y: { ...noExtras, hot_received: new Map<string, number | null>([["a1", 2]]) },
        mtd: {
            ...noExtras,
            hot_received: new Map<string, number | null>([["a1", 11]]),
            quotes_delivered: new Map<string, number | null>([["a1", 4]]),
            dealer_approved: new Map<string, number | null>([["a1", 3]]),
            won: null,
        },
    };
    const targets = new Map([["a1", new Map([["dealer_visits", 50], ["revenue", 2000000]])]]);

    it("columns: metrics across, Yesterday + MTD where it makes sense, one % of target", () => {
        expect(BLOCK_B_COLUMNS).toEqual([
            "ASM",
            "Dealers visited · Yesterday",
            "MTD",
            "Visits · Yesterday",
            "MTD",
            "Fresh · Yesterday",
            "MTD",
            "Repeat · Yesterday",
            "MTD",
            "Of which new to iTarang · Yesterday",
            "MTD",
            "Hot received · Yesterday",
            "MTD",
            "Quotes created · Yesterday",
            "MTD",
            "Quotes delivered MTD",
            "Dealer approved MTD",
            "Marked Won MTD",
            "Converted MTD",
            "Revenue ₹ MTD",
            "Limits passed · Yesterday",
            "MTD",
            "First attempt, median working hrs MTD",
            "First attempt within limit % MTD",
            "First visit within limit % MTD",
            "% of target",
        ]);
        expect(BLOCK_B_COLUMNS.some((c) => /last 7/i.test(c))).toBe(false);
    });

    it("one row per ASM in name order, then a Total row", () => {
        const blocks = buildRepBlocks("asm", y, mtd, extras, targets);
        expect(blocks.map((b) => b.name)).toEqual(["Amy", "Zed"]);
        const rows = repBlockTableRows("asm", blocks);
        expect(rows).toHaveLength(3);
        for (const r of rows) expect(r).toHaveLength(BLOCK_B_COLUMNS.length);
        // Amy: no target → "—"; a failed direct query (Marked Won MTD) is not 0.
        expect(rows[0]).toEqual(["Amy", 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, REP_NOT_MEASURED, 0, "₹0", 0, 0, REP_NOT_MEASURED, REP_NOT_MEASURED, REP_NOT_MEASURED, REP_NOT_MEASURED]);
        // Zed: 40 dealers visited MTD against a target of 50 = 80%.
        expect(rows[1]).toEqual(["Zed", 3, 40, 0, 0, 0, 0, 0, 0, 0, 7, 2, 11, 1, 6, 4, 3, REP_NOT_MEASURED, 2, "₹25.0 L", 0, 0, REP_NOT_MEASURED, REP_NOT_MEASURED, REP_NOT_MEASURED, "80%"]);
        // Total: sums of the reps; % of target only over reps that have one.
        expect(rows[2]).toEqual(["Total", 3, 50, 0, 0, 0, 0, 0, 0, 0, 7, 2, 11, 1, 6, 4, 3, REP_NOT_MEASURED, 2, "₹25.0 L", 0, 0, REP_NOT_MEASURED, REP_NOT_MEASURED, REP_NOT_MEASURED, "80%"]);
    });

    it("ID 156: a manager's team under them, with a subtotal against the MANAGER's own target", () => {
        const blocks = buildRepBlocks("asm", y, mtd, extras, targets);
        // Amy (a2) reports to Zed (a1).
        const rows = repBlockTableRows("asm", blocks, new Map([["a2", "a1"]]));
        expect(rows.map((r) => r[0])).toEqual(["Zed", "↳ Amy", "Team subtotal · Zed", "Total"]);
        // Team: 40 + 10 = 50 dealers visited MTD against Zed's own target of 50 = 100%.
        expect(rows[2][2]).toBe(50);
        expect(rows[2][rows[2].length - 1]).toBe("100%");
        // The block Total is unchanged: % over reps that have a target (Zed alone).
        expect(rows[3][rows[3].length - 1]).toBe("80%");
    });

    it("ID 155: the subtotal counts a mid-month joiner only for his days in the team", () => {
        const blocks = buildRepBlocks("asm", y, mtd, extras, targets);
        const full = new Map(blocks.map((b) => [b.id, b]));
        const zed = full.get("a1")!;
        // Amy (a2) joined Zed on the 10th: her MTD for 10th-20th is 4 dealers visited, not her month's 10.
        const amyLate = { ...full.get("a2")!, values: { ...full.get("a2")!.values, visited: { y: null, mtd: 4 } } };
        const group = datedTeamGroup({
            manager: zed,
            windows: [{ from: "2026-10-01", to: "2026-10-20", ids: ["a1"] }, { from: "2026-10-10", to: "2026-10-20", ids: ["a2"] }],
            mtd: { from: "2026-10-01", to: "2026-10-20" },
            yesterday: "2026-10-20",
            full,
            partial: new Map([["2026-10-10|2026-10-20", new Map([["a2", amyLate]])]]),
        });
        expect(group.map((b) => b.id)).toEqual(["a1", "a2"]);
        const rows = repBlockTableRows("asm", blocks, new Map([["a2", "a1"]]), new Map([["a1", group]]));
        // The listed rows keep each person's own month; the subtotal is 40 + 4 = 44 (44 / 50 = 88%).
        expect(rows[1][2]).toBe(10);
        expect(rows[2][0]).toBe("Team subtotal · Zed");
        expect(rows[2][2]).toBe(44);
        expect(rows[2][rows[2].length - 1]).toBe("88%");
    });

    it("ID 155: a member who left before yesterday adds nothing to yesterday", () => {
        const blocks = buildRepBlocks("asm", y, mtd, extras, targets);
        const full = new Map(blocks.map((b) => [b.id, b]));
        const group = datedTeamGroup({
            manager: full.get("a1")!,
            windows: [{ from: "2026-10-01", to: "2026-10-20", ids: ["a1"] }, { from: "2026-10-01", to: "2026-10-05", ids: ["a2"] }],
            mtd: { from: "2026-10-01", to: "2026-10-20" },
            yesterday: "2026-10-20",
            full,
            partial: new Map([["2026-10-01|2026-10-05", new Map([["a2", full.get("a2")!]])]]),
        });
        for (const v of Object.values(group[1].values)) expect(v?.y).toBeNull();
    });

    it("ID 155: a manager in another role (Sales Manager over ASMs) gets a header, his members and their subtotal", () => {
        const blocks = buildRepBlocks("asm", y, mtd, extras, targets);
        // Both ASMs report to sm1, a Sales Manager who is not in Block B.
        const teamOf = new Map([["a1", "sm1"], ["a2", "sm1"]]);
        const rows = repBlockTableRows("asm", blocks, teamOf, undefined, new Map([["sm1", "Sam"]]));
        expect(rows.map((r) => r[0])).toEqual(["Sam · team", "↳ Amy", "↳ Zed", "Team subtotal · Sam", "Total"]);
        // The header carries no numbers; the subtotal is the members' 10 + 40 = 50, with no target of his own here.
        expect(rows[0].slice(1).every((c) => c === "")).toBe(true);
        expect(rows[3][2]).toBe(50);
        expect(rows[3][rows[3].length - 1]).toBe(REP_NOT_MEASURED);
        // The block Total is unchanged.
        expect(rows[4][2]).toBe(50);
        expect(rows[4][rows[4].length - 1]).toBe("80%");
    });

    it("ID 155: an outside manager's dated group counts a joiner only for his days", () => {
        const blocks = buildRepBlocks("asm", y, mtd, extras, targets);
        const full = new Map(blocks.map((b) => [b.id, b]));
        const amyLate = { ...full.get("a2")!, values: { ...full.get("a2")!.values, visited: { y: null, mtd: 4 } } };
        const group = datedTeamGroup({
            manager: outsideManagerBlock("sm1", "Sam", blocks),
            windows: [
                { from: "2026-10-01", to: "2026-10-20", ids: ["sm1", "a1"] },
                { from: "2026-10-10", to: "2026-10-20", ids: ["a2"] },
            ],
            mtd: { from: "2026-10-01", to: "2026-10-20" },
            yesterday: "2026-10-20",
            full,
            partial: new Map([["2026-10-10|2026-10-20", new Map([["a2", amyLate]])]]),
        });
        expect(group.map((b) => b.id)).toEqual(["sm1", "a1", "a2"]);
        const rows = repBlockTableRows("asm", blocks, new Map([["a1", "sm1"], ["a2", "sm1"]]), new Map([["sm1", group]]), new Map([["sm1", "Sam"]]));
        // Zed's 40 + Amy's 4 from her days in the team.
        expect(rows[3][0]).toBe("Team subtotal · Sam");
        expect(rows[3][2]).toBe(44);
    });

    it("ID 155: without the manager's name the members stay ungrouped, as before", () => {
        const blocks = buildRepBlocks("asm", y, mtd, extras, targets);
        const rows = repBlockTableRows("asm", blocks, new Map([["a1", "sm1"], ["a2", "sm1"]]));
        expect(rows.map((r) => r[0])).toEqual(["Amy", "Zed", "Total"]);
    });

    it("no Total row for a single rep, and none for no reps", () => {
        const one = buildRepBlocks("asm", { per_spoc: [] }, { per_spoc: [spoc("a1", "Zed", "asm")] }, extras, new Map());
        expect(repBlockTableRows("asm", one)).toHaveLength(1);
        expect(repBlockTableRows("asm", [])).toEqual([]);
    });
});

describe("Block C (ISR / CC) — one row per rep", () => {
    it("columns follow the agreed layout (docs/neodove-contract.md, Block C)", () => {
        expect(BLOCK_C_COLUMNS).toEqual([
            "ISR",
            "Calls · Yesterday",
            "MTD",
            "Dealers called · Yesterday",
            "MTD",
            "Connected MTD",
            "Connect % MTD",
            "Engaged MTD",
            "Hot to field MTD",
            "Quotes created MTD",
            "Marked Won MTD",
            "Converted MTD",
            "Limits passed · Yesterday",
            "MTD",
            "First attempt, median working hrs MTD",
            "First attempt within limit % MTD",
            "% of target",
        ]);
    });

    it("connect % from connected / calls, engaged '—' when not measured, calls target %", () => {
        const y = { per_spoc: [spoc("i1", "Ira", "inside_sales_rep", { calls: 9, dealers_called: 7 })] };
        const mtd = {
            per_spoc: [
                spoc("i1", "Ira", "inside_sales_rep", { calls: 200, dealers_called: 120, quotes: 5, converted: 1 }),
                spoc("i2", "Bo", "inside_sales_rep"),
                spoc("a1", "Zed", "asm", { calls: 3 }),
            ],
        };
        const extras = {
            y: noExtras,
            mtd: {
                ...noExtras,
                connected: new Map<string, number | null>([["i1", 50]]),
                // Bo has calls but none of measured length → NULL from engagedCallCount.
                engaged: new Map<string, number | null>([["i1", 20], ["i2", null]]),
                hot_handed: new Map<string, number | null>([["i1", 4]]),
                won: new Map<string, number | null>([["i1", 2]]),
            },
        };
        const targets = new Map([["i1", new Map([["calls_per_day", 250]])]]);
        const rows = repBlockTableRows("inside_sales_rep", buildRepBlocks("inside_sales_rep", y, mtd, extras, targets));
        expect(rows).toEqual([
            // Bo: 0 calls → Connect % "—"; engaged not measured → "—"; no target → "—".
            ["Bo", 0, 0, 0, 0, 0, REP_NOT_MEASURED, REP_NOT_MEASURED, 0, 0, 0, 0, 0, 0, REP_NOT_MEASURED, REP_NOT_MEASURED, REP_NOT_MEASURED],
            ["Ira", 9, 200, 7, 120, 50, "25%", 20, 4, 5, 2, 1, 0, 0, REP_NOT_MEASURED, REP_NOT_MEASURED, "80%"],
            ["Total", 9, 200, 7, 120, 50, "25%", 20, 4, 5, 2, 1, 0, 0, REP_NOT_MEASURED, REP_NOT_MEASURED, "80%"],
        ]);
    });

    it("clock columns (IDs 85 / 86): limits passed add up, the median is per person and blank on the Total", () => {
        const mtd = {
            per_spoc: [spoc("i1", "Ira", "inside_sales_rep", { calls: 10 }), spoc("i2", "Bo", "inside_sales_rep", { calls: 5 })],
        };
        const extras = {
            y: { ...noExtras, limits_passed: new Map<string, number | null>([["i1", 1]]) },
            mtd: {
                ...noExtras,
                limits_passed: new Map<string, number | null>([["i1", 3], ["i2", 2]]),
                owner_median_h: new Map<string, number | null>([["i1", 2.345]]),
            },
        };
        const rows = repBlockTableRows("inside_sales_rep", buildRepBlocks("inside_sales_rep", { per_spoc: [] }, mtd, extras, new Map()));
        const at = (h: string, nth = 0) => BLOCK_C_COLUMNS.findIndex((c, i) => c === h && BLOCK_C_COLUMNS.slice(0, i).filter((x) => x === h).length === nth);
        const yCol = at("Limits passed · Yesterday");
        const median = at("First attempt, median working hrs MTD");
        // Bo, Ira, Total
        expect(rows.map((r) => [r[0], r[yCol], r[yCol + 1], r[median]])).toEqual([
            ["Bo", 0, 2, REP_NOT_MEASURED],
            ["Ira", 1, 3, 2.3],
            ["Total", 1, 5, REP_NOT_MEASURED],
        ]);
    });

    it("without the clock tables the clock columns read '—'", () => {
        const mtd = { per_spoc: [spoc("i1", "Ira", "inside_sales_rep", { calls: 10 })] };
        const rows = repBlockTableRows(
            "inside_sales_rep",
            buildRepBlocks(
                "inside_sales_rep",
                { per_spoc: [] },
                mtd,
                { y: { ...noExtras, limits_passed: null }, mtd: { ...noExtras, limits_passed: null, owner_median_h: null } },
                new Map(),
            ),
        );
        const yCol = BLOCK_C_COLUMNS.indexOf("Limits passed · Yesterday");
        expect(rows[0].slice(yCol, yCol + 3)).toEqual([REP_NOT_MEASURED, REP_NOT_MEASURED, REP_NOT_MEASURED]);
    });

    it("a failed connected query reads '—' for Connected and Connect %", () => {
        const mtd = { per_spoc: [spoc("i1", "Ira", "inside_sales_rep", { calls: 10 })] };
        const rows = repBlockTableRows(
            "inside_sales_rep",
            buildRepBlocks("inside_sales_rep", { per_spoc: [] }, mtd, { y: noExtras, mtd: { ...noExtras, connected: null } }, new Map()),
        );
        expect(rows[0].slice(5, 7)).toEqual([REP_NOT_MEASURED, REP_NOT_MEASURED]);
    });
});

describe("Block D (position)", () => {
    it("adds Awaiting field visit per owner, a (no owner) row for ready leads with no owner, and a Total row", () => {
        const d = { per_spoc: [spoc("a1", "Zed", "asm", { hot: 4, hot_old: 1, warm: 2 }), spoc("i1", "Ira", "inside_sales_rep")] };
        const awaiting = new Map([["a1", 3], ["a9", 1], [NO_OWNER_KEY, 2]]);
        const names = new Map([["a9", "Bea"]]);
        const rows = blockDRows(d, awaiting, names, 5);
        expect(BLOCK_D_COLUMNS).toContain("Awaiting field visit");
        // ID 184: the Ready-to-assign name, not "Sales-ready, no owner".
        expect(BLOCK_D_COLUMNS).toContain("Ready leads with no owner");
        expect(BLOCK_D_COLUMNS).not.toContain("Sales-ready, no owner");
        expect(rows).toEqual([
            ["Bea", 0, 0, 0, 0, 1, "—", "—"],
            ["Zed", 4, 2, 0, 1, 3, "—", "—"],
            [NO_OWNER, "—", "—", "—", "—", 2, "—", 5],
            // ID 190: the Total row adds every number down the column.
            ["Total", 4, 2, 0, 1, 6, "—", 5],
        ]);
    });

    it("18 Oct row 25: splits Awaiting field visit at the limit when the past counts are measured", () => {
        const d = { per_spoc: [spoc("a1", "Zed", "asm", { hot: 1 })] };
        const rows = blockDRows(d, new Map([["a1", 3], [NO_OWNER_KEY, 1]]), new Map(), 0, new Map([["a1", 2]]));
        expect(BLOCK_D_COLUMNS).toContain("Awaiting field visit, past the limit");
        expect(rows).toEqual([
            ["Zed", 1, 0, 0, 0, 3, 2, "—"],
            [NO_OWNER, "—", "—", "—", "—", 1, 0, 0],
            ["Total", 1, 0, 0, 0, 4, 2, 0],
        ]);
    });

    it("no (no owner) row when nothing is unowned", () => {
        const rows = blockDRows({ per_spoc: [spoc("a1", "Zed", "asm", { cold: 1 })] }, new Map(), new Map(), 0);
        expect(rows).toEqual([["Zed", 0, 0, 1, 0, 0, "—", "—"]]);
    });
});

describe("% of target red / amber / green (ID 9)", async () => {
    const { ragTone, ragToneOfCell } = await import("../rag");
    const { BLOCK_A_COLUMNS, BLOCK_A_PCT_COLUMN } = await import("../salesDailyBlockA");
    const { BLOCK_B_PCT_COLUMN, BLOCK_C_PCT_COLUMN } = await import("../salesDailyBlocks");

    it("uses Block A's thresholds: green ≥100, amber 80–99, red <80", () => {
        expect(ragTone(100)).toBe("green");
        expect(ragTone(140)).toBe("green");
        expect(ragTone(99)).toBe("amber");
        expect(ragTone(80)).toBe("amber");
        expect(ragTone(79)).toBe("red");
        expect(ragTone(0)).toBe("red");
        expect(ragTone(null)).toBeNull();
    });

    it("tones only plain percentage cells", () => {
        expect(ragToneOfCell("85%")).toBe("amber");
        expect(ragToneOfCell("120%")).toBe("green");
        expect(ragToneOfCell("—")).toBeNull();
        expect(ragToneOfCell(NOT_MEASURED)).toBeNull();
        expect(ragToneOfCell("")).toBeNull();
    });

    it("points at the % of target column in Blocks A, B and C", () => {
        expect(BLOCK_A_COLUMNS[BLOCK_A_PCT_COLUMN]).toBe("% of target");
        expect(BLOCK_B_COLUMNS[BLOCK_B_PCT_COLUMN]).toBe("% of target");
        expect(BLOCK_C_COLUMNS[BLOCK_C_PCT_COLUMN]).toBe("% of target");
    });
});

describe("rep blocks — who gets a row (reconciled on db-2, 7 Oct 2026)", () => {
    const inactive = (s: Spoc) => ({ ...s, is_active: false }) as Spoc;
    const extras = { y: noExtras, mtd: noExtras };

    it("Block C lists a non-ISR who made calls, named with their role", () => {
        const mtd = { per_spoc: [spoc("i1", "Nidhi", "inside_sales_rep", { calls: 130 }), spoc("p1", "Chirag", "partner", { calls: 10 })] };
        const names = buildRepBlocks("inside_sales_rep", { per_spoc: [] }, mtd, extras, new Map()).map((b) => b.name);
        expect(names).toEqual(["Chirag · Partner", "Nidhi"]);
    });

    it("Block C leaves out a non-ISR with no calls, and Block B never takes callers", () => {
        const mtd = { per_spoc: [spoc("p1", "Chirag", "partner", { quotes: 1 }), spoc("a1", "Jiten", "asm", { calls: 4 })] };
        expect(buildRepBlocks("inside_sales_rep", { per_spoc: [] }, mtd, extras, new Map())).toEqual([]);
        expect(buildRepBlocks("asm", { per_spoc: [] }, mtd, extras, new Map()).map((b) => b.name)).toEqual(["Jiten"]);
    });

    it("drops a deactivated rep with nothing in either window, keeps (and marks) one who did something", () => {
        const mtd = {
            per_spoc: [
                inactive(spoc("a1", "Abhishek", "asm", { warm: 53 })),
                inactive(spoc("a2", "Ganesh", "asm", { unique_visits: 2 })),
                spoc("a3", "Jiten", "asm"),
            ],
        };
        const names = buildRepBlocks("asm", { per_spoc: [] }, mtd, extras, new Map()).map((b) => b.name);
        expect(names).toEqual(["Ganesh (inactive)", "Jiten"]);
    });

    it("Block D marks a deactivated owner still holding leads", () => {
        const d = { per_spoc: [inactive(spoc("a1", "Abhishek", "asm", { warm: 53 }))] };
        const rows = blockDRows(d, new Map([["a1", 53]]), new Map(), 0);
        expect(rows[0][0]).toBe("Abhishek (inactive)");
    });
});

describe("A2 · By person (ID 188) — the Sales Head's columns per person", async () => {
    const { BY_PERSON_COLUMNS, BY_PERSON_PCT_COLUMN, byPersonRows } = await import("../salesDailyBlocks");
    const extras = { y: noExtras, mtd: noExtras };
    const y = { per_spoc: [spoc("a1", "Zed", "asm", { unique_visits: 3 }), spoc("i1", "Ira", "inside_sales_rep", { calls: 9 })] };
    const mtd = {
        per_spoc: [
            spoc("a1", "Zed", "asm", { unique_visits: 40 }),
            spoc("a2", "Amy", "asm", { unique_visits: 20 }),
            spoc("i1", "Ira", "inside_sales_rep", { calls: 120 }),
        ],
    };
    const prev = { per_spoc: [spoc("a1", "Zed", "asm", { unique_visits: 2 }), spoc("i1", "Ira", "inside_sales_rep", { calls: 11 })] };
    const wk = { per_spoc: [spoc("a2", "Amy", "asm", { unique_visits: 4 }), spoc("i1", "Ira", "inside_sales_rep", { calls: 7 })] };
    const targets = new Map([
        ["a1", new Map([["dealer_visits", 50]])],
        ["i1", new Map([["calls_per_day", 100]])],
    ]);

    it("has Block A's period columns", () => {
        expect(BY_PERSON_COLUMNS).toEqual(["Person", "Yesterday", "Day before", "Same day last week", "MTD", "MTD target", "% of target"]);
        expect(BY_PERSON_PCT_COLUMN).toBe(6);
    });

    it("lists ASMs on dealers visited, then ISRs on calls, each with a Total when more than one", () => {
        const rows = byPersonRows(
            [
                { role: "asm", blocks: buildRepBlocks("asm", y, mtd, extras, targets) },
                { role: "inside_sales_rep", blocks: buildRepBlocks("inside_sales_rep", y, mtd, extras, targets) },
            ],
            { prev, wk },
        );
        expect(rows).toEqual([
            ["FIELD TEAM (ASM) · DEALERS VISITED", "", "", "", "", "", ""],
            ["Amy", 0, 0, 4, 20, REP_NOT_MEASURED, REP_NOT_MEASURED],
            ["Zed", 3, 2, 0, 40, 50, "80%"],
            // % of target on the people who have a target: Zed 40 / 50.
            ["Total", 3, 2, 4, 60, 50, "80%"],
            ["INSIDE SALES (ISR / CC) · CALLS", "", "", "", "", "", ""],
            ["Ira", 9, 11, 7, 120, 100, "120%"],
        ]);
    });

    it("skips an empty group and leaves out an inactive person with nothing", () => {
        const gone = { ...spoc("a3", "Old", "asm"), is_active: false } as typeof y.per_spoc[number];
        const rows = byPersonRows(
            [
                { role: "asm", blocks: buildRepBlocks("asm", { per_spoc: [gone] }, { per_spoc: [gone] }, extras, new Map()) },
                { role: "inside_sales_rep", blocks: [] },
            ],
            { prev: { per_spoc: [] }, wk: { per_spoc: [] } },
        );
        expect(rows).toEqual([]);
    });
});
