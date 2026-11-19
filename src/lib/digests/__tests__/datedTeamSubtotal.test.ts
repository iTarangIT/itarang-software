/**
 * ID 155 — the Daily Sales email's "Team subtotal", end to end on the pure parts:
 * dated reporting lines (teamStints rows) → teamWindows → datedTeamGroup → the
 * subtotal row. A member counts only for the dates of his stint under the
 * manager (effective_to is exclusive), MTD and yesterday alike.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
const { datedTeamGroup, outsideManagerBlock, repBlockTableRows, TEAM_SUBTOTAL_PREFIX } = await import("../salesDailyBlocks");
const { teamWindows } = await import("@/lib/users/teamWindows");
type RepBlock = import("../salesDailyBlocks").RepBlock;

const MTD = { from: "2026-11-01", to: "2026-11-18" };
const YESTERDAY = "2026-11-18";

const block = (id: string, mtd: number, y: number): RepBlock => ({ id, name: id.toUpperCase(), values: { visited: { y, mtd } }, target: null });

// Whole-month numbers of each rep (what the email reads for its own rows).
const full = new Map<string, RepBlock>([
    ["m", block("m", 10, 1)],
    ["a", block("a", 20, 2)],
    ["b", block("b", 50, 1)],
    ["c", block("c", 70, 3)],
    ["d", block("d", 90, 1)],
    ["e", block("e", 99, 9)],
]);

// The reporting lines this month (as teamStints returns them).
const stints = [
    { user_id: "a", effective_from: "2026-10-01", effective_to: null }, // the whole month
    { user_id: "b", effective_from: "2026-11-10", effective_to: null }, // joined on the 10th
    { user_id: "c", effective_from: "2026-10-15", effective_to: "2026-11-18" }, // left: last day the 17th
    { user_id: "d", effective_from: "2026-10-01", effective_to: "2026-11-05" }, // left (last day the 4th) …
    { user_id: "d", effective_from: "2026-11-12", effective_to: null }, // … and came back on the 12th
    { user_id: "e", effective_from: "2026-11-19", effective_to: null }, // starts after the period
];

// What the email reads per shorter window (buildSalesDashboard over [from, to] for those ids).
const windowMtd: Record<string, Record<string, number>> = {
    "2026-11-10|2026-11-18": { b: 5 },
    "2026-11-01|2026-11-17": { c: 7 },
    "2026-11-01|2026-11-04": { d: 2 },
    "2026-11-12|2026-11-18": { d: 3 },
};

function groupFor(manager: RepBlock) {
    const windows = teamWindows(manager.id, stints, MTD.from, MTD.to);
    const partial = new Map<string, Map<string, RepBlock>>();
    for (const w of windows) {
        const key = `${w.from}|${w.to}`;
        if (key === `${MTD.from}|${MTD.to}`) continue;
        partial.set(key, new Map(w.ids.map((id) => [id, block(id, windowMtd[key]?.[id] ?? -1000, -1000)])));
    }
    return { windows, group: datedTeamGroup({ manager, windows, mtd: MTD, yesterday: YESTERDAY, full, partial }) };
}

const sum = (g: RepBlock[], p: "y" | "mtd") => g.reduce((a, b) => a + (b.values.visited?.[p] ?? 0), 0);

describe("ID 155 — Team subtotal from dated stints", () => {
    it("clips each stint to the month; effective_to is exclusive; a stint after the period adds nothing", () => {
        const { windows } = groupFor(full.get("m")!);
        expect(windows).toEqual([
            { from: "2026-11-01", to: "2026-11-04", ids: ["d"] },
            { from: "2026-11-01", to: "2026-11-17", ids: ["c"] },
            { from: "2026-11-01", to: "2026-11-18", ids: ["m", "a"] },
            { from: "2026-11-10", to: "2026-11-18", ids: ["b"] },
            { from: "2026-11-12", to: "2026-11-18", ids: ["d"] },
        ]);
    });

    it("MTD: each member only for his days in the team, a re-joiner for both stints", () => {
        const { group } = groupFor(full.get("m")!);
        // m 10 + a 20 (whole month) + b 5 + c 7 + d 2 + 3; e (starts the 19th) is not in it.
        expect(sum(group, "mtd")).toBe(47);
        expect(group.some((b) => b.id === "e")).toBe(false);
    });

    it("yesterday: only members whose stint covers yesterday, each once", () => {
        const { group } = groupFor(full.get("m")!);
        // m 1 + a 2 + b 1 + d 1 (second stint); c left before yesterday; d's first stint adds nothing.
        expect(sum(group, "y")).toBe(5);
        expect(group.filter((b) => b.id === "c").every((b) => b.values.visited?.y == null)).toBe(true);
        expect(group.filter((b) => b.id === "d").map((b) => b.values.visited?.y ?? null)).toEqual([null, 1]);
    });

    it("a manager of another role gets the same dated subtotal (no numbers of his own in the block)", () => {
        const members = ["a", "b", "c", "d"].map((id) => full.get(id)!);
        const { group } = groupFor(outsideManagerBlock("m", "Sam", members));
        expect(sum(group, "mtd")).toBe(37); // 47 less the manager's own 10
        expect(sum(group, "y")).toBe(4);
    });

    it("the subtotal row prints the dated sums, not the listed members' whole month", () => {
        const { group } = groupFor(full.get("m")!);
        const blocks = ["m", "a", "b"].map((id) => full.get(id)!);
        const rows = repBlockTableRows("asm", blocks, new Map([["a", "m"], ["b", "m"]]), new Map([["m", group]]));
        const sub = rows.find((r) => r[0] === TEAM_SUBTOTAL_PREFIX + "M")!;
        expect(sub).toBeDefined();
        expect(sub).toContain(47);
    });
});
