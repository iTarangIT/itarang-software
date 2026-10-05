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
            "New dealers visited · Yesterday",
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
        expect(rows[0]).toEqual(["Amy", 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, REP_NOT_MEASURED, 0, "₹0", REP_NOT_MEASURED]);
        // Zed: 40 dealers visited MTD against a target of 50 = 80%.
        expect(rows[1]).toEqual(["Zed", 3, 40, 0, 7, 2, 11, 1, 6, 4, 3, REP_NOT_MEASURED, 2, "₹25.0 L", "80%"]);
        // Total: sums of the reps; % of target only over reps that have one.
        expect(rows[2]).toEqual(["Total", 3, 50, 0, 7, 2, 11, 1, 6, 4, 3, REP_NOT_MEASURED, 2, "₹25.0 L", "80%"]);
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
            ["Bo", 0, 0, 0, 0, 0, REP_NOT_MEASURED, REP_NOT_MEASURED, 0, 0, 0, 0, REP_NOT_MEASURED],
            ["Ira", 9, 200, 7, 120, 50, "25%", 20, 4, 5, 2, 1, "80%"],
            ["Total", 9, 200, 7, 120, 50, "25%", 20, 4, 5, 2, 1, "80%"],
        ]);
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
    it("adds Awaiting field visit per owner and a (no owner) row for sales-ready leads", () => {
        const d = { per_spoc: [spoc("a1", "Zed", "asm", { hot: 4, hot_old: 1, warm: 2 }), spoc("i1", "Ira", "inside_sales_rep")] };
        const awaiting = new Map([["a1", 3], ["a9", 1], [NO_OWNER_KEY, 2]]);
        const names = new Map([["a9", "Bea"]]);
        const rows = blockDRows(d, awaiting, names, 5);
        expect(BLOCK_D_COLUMNS).toContain("Awaiting field visit");
        expect(BLOCK_D_COLUMNS).toContain("Sales-ready, no owner");
        expect(rows).toEqual([
            ["Bea", 0, 0, 0, 0, 1, "—"],
            ["Zed", 4, 2, 0, 1, 3, "—"],
            [NO_OWNER, "—", "—", "—", "—", 2, 5],
        ]);
    });

    it("no (no owner) row when nothing is unowned", () => {
        const rows = blockDRows({ per_spoc: [spoc("a1", "Zed", "asm", { cold: 1 })] }, new Map(), new Map(), 0);
        expect(rows).toEqual([["Zed", 0, 0, 1, 0, 0, "—"]]);
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
