/**
 * Daily Sales email — Blocks B / C / D row shaping (tracker ID 9).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
const {
    BLOCK_D_COLUMNS,
    NO_OWNER,
    NO_OWNER_KEY,
    REP_BLOCK_COLUMNS,
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
    hot_received: new Map<string, number>(),
    hot_handed: new Map<string, number>(),
    engaged: new Map<string, number>(),
    quotes_delivered: new Map<string, number>(),
    dealer_approved: new Map<string, number>(),
    won: new Map<string, number>(),
};

describe("Blocks B / C (per rep)", () => {
    it("one block per rep of the role, metrics from the builder and the direct counts", () => {
        const y = { per_spoc: [spoc("a1", "Zed", "asm", { unique_visits: 3, revenue: 150000 }), spoc("i1", "Ira", "inside_sales_rep", { calls: 9 })] };
        const mtd = { per_spoc: [spoc("a1", "Zed", "asm", { unique_visits: 40, new_visits: 7, revenue: 2500000 }), spoc("a2", "Amy", "asm"), spoc("i1", "Ira", "inside_sales_rep", { calls: 210 })] };
        const extras = {
            y: { ...noExtras, hot_received: new Map([["a1", 2]]) },
            mtd: { ...noExtras, hot_received: new Map([["a1", 11]]), won: null },
        };
        const targets = new Map([["a1", new Map([["dealer_visits", 50], ["revenue", 2000000]])]]);

        const asm = buildRepBlocks("asm", y, mtd, extras, targets);
        expect(asm.map((b) => b.name)).toEqual(["Amy", "Zed"]);
        const zed = asm[1];
        expect(zed.metrics.map((m) => m.label)).toEqual([
            "Dealers visited",
            "New dealers visited",
            "Hot received",
            "Quotes created",
            "Quotes delivered",
            "Dealer approved",
            "Marked Won",
            "Converted",
            "Revenue",
        ]);
        expect(zed.metrics[0]).toMatchObject({ y: 3, mtd: 40, target: 50 });
        expect(zed.metrics[2]).toMatchObject({ y: 2, mtd: 11, target: null });
        // A failed direct query is "not measured", not 0.
        expect(zed.metrics[6]).toMatchObject({ y: 0, mtd: null });

        const isr = buildRepBlocks("inside_sales_rep", y, mtd, extras, targets);
        expect(isr).toHaveLength(1);
        expect(isr[0].metrics.map((m) => m.label)).toEqual([
            "Calls made",
            "Dealers called",
            "Engaged calls",
            "Hot handed to field",
            "Quotes created",
            "Marked Won",
            "Converted",
        ]);
        expect(isr[0].metrics[0]).toMatchObject({ y: 9, mtd: 210 });
    });

    it("renders a group header per rep, then Yesterday · MTD · target · %", () => {
        expect(REP_BLOCK_COLUMNS).toEqual(["Metric", "Yesterday", "MTD", "MTD target", "% of target"]);
        const rows = repBlockTableRows([
            {
                id: "a1",
                name: "Zed",
                metrics: [
                    { label: "Dealers visited", kind: "count", y: 3, mtd: 40, target: 50 },
                    { label: "Revenue", kind: "money", y: 150000, mtd: 2500000, target: null },
                    { label: "Marked Won", kind: "count", y: 0, mtd: null, target: null },
                ],
            },
        ]);
        expect(rows[0]).toEqual(["Zed", "", "", "", ""]);
        expect(rows[1]).toEqual(["Dealers visited", "3", "40", "50", "80%"]);
        expect(rows[2]).toEqual(["Revenue", "₹1.5 L", "₹25.0 L", "—", "—"]);
        expect(rows[3]).toEqual(["Marked Won", "0", NOT_MEASURED, "—", "—"]);
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
