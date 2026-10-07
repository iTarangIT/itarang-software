/**
 * Daily Sales email — the business template (docs/crm-reports-admin, "Daily
 * Sales email · Block A") and the "Data updated till" cut-off.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
const { blockAHeadlineParts, blockARowNotes, blockATableRows, lastMonthColumnLabel } = await import("../salesDailyBlockA");
const { istStamp } = await import("../kinds/sales-daily");
const { workingDaysElapsed, median } = await import("../workingTime");
const { buildDigestEmail } = await import("@/lib/email/sendDigestEmail");

const row = (label: string, group: "INTAKE" | "EFFORT", over: Record<string, unknown> = {}) => ({
    group,
    label,
    kind: "count" as const,
    values: { y: 4, d7: 12, mtd: 9, lm: 10 },
    target: null,
    ...over,
});

describe("Block A pieces", () => {
    it("names the last-month column by its dates, as the template does", () => {
        expect(lastMonthColumnLabel({ from: "2026-09-01", to: "2026-09-04" })).toBe("1–4 Sep");
        expect(lastMonthColumnLabel({ from: "2026-09-01", to: "2026-09-01" })).toBe("1 Sep");
    });

    it("splits the headline into a Yesterday part and a Month to date part", () => {
        const parts = blockAHeadlineParts([
            row("New dealers visited", "EFFORT", { values: { y: 12, d7: 71, mtd: 238, lm: 262 }, target: 305 }),
        ]);
        expect(parts).toHaveLength(2);
        expect(parts[0]).toMatch(/^Yesterday: /);
        expect(parts[1]).toBe("Month to date: behind target on new dealers visited at 78%.");
        // No targets at all: only the Yesterday part.
        expect(blockAHeadlineParts([row("Leads in", "INTAKE")])).toHaveLength(1);
    });

    it("gives one note per table row, null on group headers", () => {
        const rows = [row("Leads in", "INTAKE"), row("Calls made", "EFFORT"), row("Something new", "EFFORT")];
        const notes = blockARowNotes(rows);
        expect(notes).toHaveLength(blockATableRows(rows).length);
        expect(notes).toEqual([null, "Leads that arrived on their own", null, "Inside sales and NeoDove, AI calls excluded", null]);
    });
});

describe("Data updated till", () => {
    it("prints the cut-off in IST, 12-hour clock", () => {
        // 08:33 UTC = 14:03 IST
        expect(istStamp(new Date("2026-10-05T08:33:00Z"))).toBe("5 Oct 2026, 2:03 PM");
    });
});

describe("workingDaysElapsed — the median-wait unit", () => {
    const none = new Set<string>();
    it("counts elapsed hours on working days only", () => {
        // Mon 09:00 → Tue 09:00 IST = one working day.
        expect(workingDaysElapsed(new Date("2026-10-05T03:30:00Z"), new Date("2026-10-06T03:30:00Z"), none)).toBeCloseTo(1, 5);
        // Sat 18:00 IST → Mon 06:00 IST skips Sunday: 6 h Sat + 6 h Mon = 0.5.
        expect(workingDaysElapsed(new Date("2026-10-03T12:30:00Z"), new Date("2026-10-05T00:30:00Z"), none)).toBeCloseTo(0.5, 5);
    });
    it("skips a holiday, and is 0 for a wait that never happened", () => {
        const hol = new Set(["2026-10-02"]);
        // Thu 12:00 → Fri 12:00 IST, Friday a holiday: 12 h = 0.5.
        expect(workingDaysElapsed(new Date("2026-10-01T06:30:00Z"), new Date("2026-10-02T06:30:00Z"), hol)).toBeCloseTo(0.5, 5);
        expect(workingDaysElapsed(new Date("2026-10-02T06:30:00Z"), new Date("2026-10-01T06:30:00Z"), none)).toBe(0);
    });
    it("median", () => {
        expect(median([])).toBeNull();
        expect(median([3, 1, 2])).toBe(2);
        expect(median([4, 1, 2, 3])).toBe(2.5);
    });
});

describe("the masthead layout", () => {
    const KIND = {
        id: "sales_daily",
        label: "Sales Daily",
        ctaHref: "/admin/reports/sales-dashboard",
        ctaLabel: "Open Sales Dashboard",
        slots: ["morning"],
    } as never;
    const figures = {
        activity: [],
        backlog: [],
        headline: ["Yesterday: 2 dealers converted.", "Month to date: behind target on revenue at 72%."],
        masthead: {
            title: "Daily Sales · Sun 4 Oct 2026",
            audience: "iTarang CRM to Sales leadership",
            dataAsOf: "5 Oct 2026, 2:03 PM",
            eyebrow: "ITARANG · DAILY SALES",
            dayHeading: "Sunday 4 October",
            intro: "Covers Sunday 4 October, midnight to midnight IST.",
            footer: "Sent by the iTarang CRM every morning at 09:00 IST. Recipients are set by Admin.",
        },
        tables: [
            {
                key: "block_a",
                title: "A · Company",
                columns: ["Metric", "Yesterday", "Last 7 days", "MTD", "MTD target", "% of target", "1–4 Sep", "Δ MTD"],
                rows: [
                    ["INTAKE", "", "", "", "", "", "", ""],
                    ["Revenue", "₹0", "₹47.3 L", "₹0", "₹3.05 Cr", "72%", "₹13.0 L", "−100%"],
                ],
                rowNotes: [null, "Invoices matched to a dealer"],
                textColumns: 1,
                groupHeaders: true,
                toneColumns: [5],
                deltaColumns: [7],
                strongColumn: 3,
                phoneColumns: [0, 1, 3, 5],
                phoneDeltaUnder: [7, 3] as [number, number],
            },
        ],
    };
    const m = buildDigestEmail({ kind: KIND, to: ["a@b.c"], slot: "morning", istDay: "2026-10-04", figures });

    it("puts the data cut-off at the top of both bodies", () => {
        expect(m.html).toContain("Data updated till <span");
        expect(m.html.indexOf("5 Oct 2026, 2:03 PM")).toBeLessThan(m.html.indexOf("A · Company"));
        expect(m.text.split("\n").slice(0, 2)).toEqual(["Daily Sales · Sun 4 Oct 2026", "Data updated till 5 Oct 2026, 2:03 PM"]);
    });

    it("renders the template's pieces: bold headline label, row note, red pill, red Δ, dated column", () => {
        expect(m.html).toContain('<span style="font-weight:700">Yesterday:</span>');
        expect(m.html).toContain("Invoices matched to a dealer");
        expect(m.html).toMatch(/background:#fee2e2;color:#b91c1c">72%/);
        expect(m.html).toMatch(/color:#B91C1C">−100%/);
        expect(m.html).toContain(">1–4 Sep</th>");
    });

    it("hides the desktop-only columns on a phone and shows Δ under MTD there", () => {
        expect(m.html).toContain("@media only screen and (max-width:600px)");
        // Last 7 days, MTD target, last month and Δ carry the desktop class.
        expect((m.html.match(/<th class="sd-desk"/g) ?? []).length).toBe(4);
        expect(m.html).toContain('<div class="sd-mob" style="display:none');
    });
});
