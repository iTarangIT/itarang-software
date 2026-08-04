import { describe, it, expect } from "vitest";
import {
    initialDir,
    isEmpty,
    makeComparator,
    nextSortState,
    sortRows,
    type SortSpec,
} from "./tableSortCore";

// E-224. These tables are financial lists, so the failure mode that matters is
// not "the order is odd" but "the order implies something untrue" — a dateless
// row heading an ascending date column reads as the earliest invoice, and an
// unparseable amount sorting as NaN scrambles everything around it.

interface Row {
    invoice: string | null;
    amount: string | null;
    date: string | null;
}

const spec = (key: keyof Row, type: SortSpec<Row>["type"]): SortSpec<Row> => ({
    key,
    type,
});

const rows = (...rs: Partial<Row>[]): Row[] =>
    rs.map((r) => ({ invoice: null, amount: null, date: null, ...r }));

describe("isEmpty", () => {
    it("treats null, undefined and blank strings as absent", () => {
        expect(isEmpty(null)).toBe(true);
        expect(isEmpty(undefined)).toBe(true);
        expect(isEmpty("")).toBe(true);
        expect(isEmpty("   ")).toBe(true);
    });

    it("does NOT treat zero or false as absent", () => {
        // A ₹0 line is a value. Sinking it to the bottom with the unknowns would
        // hide a genuinely zero-rupee invoice.
        expect(isEmpty(0)).toBe(false);
        expect(isEmpty(false)).toBe(false);
        expect(isEmpty("0")).toBe(false);
    });
});

describe("initialDir — which way a column opens", () => {
    it("opens text A→Z and numbers/dates largest-first", () => {
        expect(initialDir("text")).toBe("asc");
        expect(initialDir("number")).toBe("desc");
        expect(initialDir("date")).toBe("desc");
    });
});

describe("nextSortState — the three-state click cycle", () => {
    it("sorts, reverses, then returns to server order", () => {
        const a = nextSortState(null, "amount", "number");
        expect(a).toEqual({ key: "amount", dir: "desc" });
        const b = nextSortState(a, "amount", "number");
        expect(b).toEqual({ key: "amount", dir: "asc" });
        expect(nextSortState(b, "amount", "number")).toBeNull();
    });

    it("runs the same cycle for a text column, starting ascending", () => {
        const a = nextSortState(null, "invoice", "text");
        expect(a).toEqual({ key: "invoice", dir: "asc" });
        const b = nextSortState(a, "invoice", "text");
        expect(b).toEqual({ key: "invoice", dir: "desc" });
        expect(nextSortState(b, "invoice", "text")).toBeNull();
    });

    it("switching columns starts that column's own cycle, not the old one's", () => {
        const onAmount = { key: "amount", dir: "asc" } as const;
        expect(nextSortState(onAmount, "invoice", "text")).toEqual({
            key: "invoice",
            dir: "asc",
        });
    });
});

describe("makeComparator — empties sink in BOTH directions", () => {
    const data = rows(
        { date: "2026-07-30" },
        { date: null },
        { date: "2026-07-10" },
        { date: "" },
    );

    it("keeps unknown dates last when ascending", () => {
        const sorted = sortRows(data, makeComparator(spec("date", "date"), "asc"));
        expect(sorted.map((r) => r.date)).toEqual(["2026-07-10", "2026-07-30", null, ""]);
    });

    it("keeps unknown dates last when descending too", () => {
        const sorted = sortRows(data, makeComparator(spec("date", "date"), "desc"));
        expect(sorted.map((r) => r.date)).toEqual(["2026-07-30", "2026-07-10", null, ""]);
    });

    // Regression: an earlier version handled the unparseable case inside the
    // comparison, so the `desc` flip negated it — bad values sank when
    // ascending and floated to the TOP when descending.
    it("sinks an unparseable date in both directions, not just ascending", () => {
        const messy = rows({ date: "2026-07-30" }, { date: "not a date" }, { date: "2026-01-01" });
        expect(
            sortRows(messy, makeComparator(spec("date", "date"), "desc")).map((r) => r.date),
        ).toEqual(["2026-07-30", "2026-01-01", "not a date"]);
        expect(
            sortRows(messy, makeComparator(spec("date", "date"), "asc")).map((r) => r.date),
        ).toEqual(["2026-01-01", "2026-07-30", "not a date"]);
    });

    it("does the same for an unparseable amount", () => {
        const messy = rows({ amount: "1200" }, { amount: "N/A" }, { amount: "50" });
        expect(
            sortRows(messy, makeComparator(spec("amount", "number"), "desc")).map((r) => r.amount),
        ).toEqual(["1200", "50", "N/A"]);
        expect(
            sortRows(messy, makeComparator(spec("amount", "number"), "asc")).map((r) => r.amount),
        ).toEqual(["50", "1200", "N/A"]);
    });
});

describe("makeComparator — numbers", () => {
    it("orders numeric strings by value, not lexically", () => {
        // The API returns numeric(14,2) as a string; "9" > "10" lexically.
        const data = rows({ amount: "9" }, { amount: "10" }, { amount: "2100000.50" });
        const sorted = sortRows(data, makeComparator(spec("amount", "number"), "desc"));
        expect(sorted.map((r) => r.amount)).toEqual(["2100000.50", "10", "9"]);
    });

    it("keeps a zero amount in the list rather than sinking it", () => {
        const data = rows({ amount: "5" }, { amount: "0" }, { amount: null });
        const sorted = sortRows(data, makeComparator(spec("amount", "number"), "asc"));
        expect(sorted.map((r) => r.amount)).toEqual(["0", "5", null]);
    });
});

describe("makeComparator — text", () => {
    it("is case-insensitive", () => {
        const data = rows({ invoice: "beta" }, { invoice: "Alpha" }, { invoice: "gamma" });
        const sorted = sortRows(data, makeComparator(spec("invoice", "text"), "asc"));
        expect(sorted.map((r) => r.invoice)).toEqual(["Alpha", "beta", "gamma"]);
    });

    it("orders embedded numbers naturally", () => {
        const data = rows({ invoice: "INV-10" }, { invoice: "INV-2" }, { invoice: "INV-1" });
        const sorted = sortRows(data, makeComparator(spec("invoice", "text"), "asc"));
        expect(sorted.map((r) => r.invoice)).toEqual(["INV-1", "INV-2", "INV-10"]);
    });

    it("uses a custom accessor when the column renders a label", () => {
        // The Dept column shows "Operations" but stores "ops" — sorting has to
        // follow what is on screen.
        const label: Record<string, string> = { ops: "Operations", tech: "Tech", admin: "Admin" };
        const data = [{ dept: "tech" }, { dept: "ops" }, { dept: "admin" }];
        const cmp = makeComparator<{ dept: string }>(
            { key: "dept", type: "text", value: (r) => label[r.dept] },
            "asc",
        );
        expect(sortRows(data, cmp).map((r) => r.dept)).toEqual(["admin", "ops", "tech"]);
    });
});

describe("sortRows", () => {
    it("does not mutate the input", () => {
        const data = rows({ amount: "1" }, { amount: "3" }, { amount: "2" });
        const before = data.map((r) => r.amount);
        sortRows(data, makeComparator(spec("amount", "number"), "desc"));
        expect(data.map((r) => r.amount)).toEqual(before);
    });

    it("returns the same array by reference when unsorted", () => {
        const data = rows({ amount: "1" });
        expect(sortRows(data, null)).toBe(data);
    });

    it("is stable, so ties keep the server's ordering", () => {
        const data = [
            { invoice: "first", amount: "100" },
            { invoice: "second", amount: "100" },
            { invoice: "third", amount: "100" },
        ];
        const cmp = makeComparator<{ invoice: string; amount: string }>(
            { key: "amount", type: "number" },
            "desc",
        );
        expect(sortRows(data, cmp).map((r) => r.invoice)).toEqual([
            "first",
            "second",
            "third",
        ]);
    });
});
