/**
 * "My day" (ID 194) — a person's rows are the management email's rows.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
const { buildRepBlocks, repBlockTableRows, TEAM_SUBTOTAL_PREFIX, TEAM_MEMBER_PREFIX } = await import("../salesDailyBlocks");
const { personRows, teamRows, membersOf, targetRows, workListRows, sameDayLastWeekRows } = await import("../myDayShape");
const { buildDigestEmail } = await import("@/lib/email/sendDigestEmail");

const spoc = (id: string, name: string, role: string, calls: number, visits = 0) => ({
    spoc_id: id,
    name,
    role,
    is_active: true,
    totals: { visits, unique_visits: visits, new_visits: 0, calls, dealers_called: calls, converted: 0, new_hot: 0, hot_converted: 0 },
    outcome: { quotes_issued: 0, quote_revisions: 0, revenue: 0, batteries_to_dealers: 0, kyc_submitted: 0 },
    interest: { ageing_basis: "interest_changed_at", rows: [] },
});

const extras = () => ({
    hot_received: new Map(),
    hot_handed: new Map(),
    connected: new Map(),
    engaged: new Map(),
    quotes_delivered: new Map(),
    dealer_approved: new Map(),
    won: new Map(),
    limits_passed: new Map(),
    owner_median_h: new Map(),
});

const dash = {
    per_spoc: [
        spoc("lead", "Sonu", "inside_sales_rep", 40),
        spoc("a", "Asha", "inside_sales_rep", 10),
        spoc("b", "Bala", "inside_sales_rep", 20),
        spoc("c", "Chetan", "inside_sales_rep", 5),
    ],
} as never;
const targets = new Map([["lead", new Map([["calls_per_day", 50]])]]);
const blocks = buildRepBlocks("inside_sales_rep", dash, dash, { y: extras(), mtd: extras() }, targets);
const teamOf = new Map([
    ["a", "lead"],
    ["b", "lead"],
]);
const management = repBlockTableRows("inside_sales_rep", blocks, teamOf);

describe("personRows", () => {
    it("is the person's own row in the management email", () => {
        const [row] = personRows("inside_sales_rep", blocks, "c");
        expect(management).toContainEqual(row);
        const [lead] = personRows("inside_sales_rep", blocks, "lead");
        expect(lead).toEqual(management.find((r) => r[0] === "Sonu"));
    });
    it("is empty for someone not in the block", () => {
        expect(personRows("inside_sales_rep", blocks, "nobody")).toEqual([]);
    });
});

// ID 194 #1 — Yesterday against the same day last week, per metric.
describe("sameDayLastWeekRows", () => {
    const wkDash = { per_spoc: [spoc("c", "Chetan", "inside_sales_rep", 12)] } as never;
    const wkBlocks = buildRepBlocks("inside_sales_rep", wkDash, wkDash, { y: extras(), mtd: extras() }, targets);
    it("lists each Yesterday metric with both days", () => {
        const rows = sameDayLastWeekRows("inside_sales_rep", blocks, wkBlocks, "c");
        expect(rows.map((r) => r[0])).toEqual(["Calls", "Dealers called", "Limits passed"]);
        expect(rows[0]).toEqual(["Calls", 5, 12]);
    });
    it("is 0 on the day the person is missing from", () => {
        const rows = sameDayLastWeekRows("inside_sales_rep", blocks, wkBlocks, "a");
        expect(rows[0]).toEqual(["Calls", 10, 0]);
    });
    it("is empty for someone in neither", () => {
        expect(sameDayLastWeekRows("inside_sales_rep", blocks, wkBlocks, "nobody")).toEqual([]);
    });
});

describe("teamRows", () => {
    it("lists the manager, the members and the same team subtotal as the management email", () => {
        const rows = teamRows("inside_sales_rep", blocks, "lead", teamOf);
        expect(rows.map((r) => r[0])).toEqual([
            "Sonu",
            `${TEAM_MEMBER_PREFIX}Asha`,
            `${TEAM_MEMBER_PREFIX}Bala`,
            `${TEAM_SUBTOTAL_PREFIX}Sonu`,
        ]);
        const sub = management.find((r) => r[0] === `${TEAM_SUBTOTAL_PREFIX}Sonu`);
        expect(rows[3]).toEqual(sub);
        // No company Total, and nobody outside the team.
        expect(rows.some((r) => r[0] === "Total" || String(r[0]).includes("Chetan"))).toBe(false);
    });
    it("is empty for someone with no team", () => {
        expect(teamRows("inside_sales_rep", blocks, "c", teamOf)).toEqual([]);
        expect(membersOf(teamOf, "c")).toEqual([]);
    });
    it("lists only the members when the manager is not in this block — no cross-role Team total (ID 194)", () => {
        const rows = teamRows("inside_sales_rep", blocks, "asm-lead", new Map([["a", "asm-lead"], ["b", "asm-lead"]]));
        expect(rows.map((r) => r[0])).toEqual(["Asha", "Bala"]);
    });
});

describe("teamOverdueRows (ID 194)", () => {
    it("lists the manager, each member (↳) and a team subtotal of overdue follow-ups and visits", async () => {
        const { teamOverdueRows } = await import("../myDayShape");
        const rows = teamOverdueRows("m", [
            { id: "b", name: "Bala", followUps: 2, visits: 1 },
            { id: "m", name: "Mona", followUps: 0, visits: 3 },
            { id: "a", name: "Asha", followUps: 4, visits: 0 },
        ]);
        expect(rows).toEqual([
            ["Mona", 0, 3],
            ["↳ Asha", 4, 0],
            ["↳ Bala", 2, 1],
            ["Team subtotal · Mona", 6, 4],
        ]);
        expect(teamOverdueRows("m", [])).toEqual([]);
    });
});

describe("targetRows", () => {
    it("formats per-day targets as a daily rate and colours by %", () => {
        expect(targetRows([{ label: "Calls per day", kind: "per_day", target: 50, actual: 40 }])).toEqual([
            ["Calls per day", "50 a day", "40 a day", "80%"],
        ]);
        expect(targetRows([{ label: "Visits", kind: "count", target: 10, actual: null }])[0][2]).toBe("—");
    });
});

describe("workListRows", () => {
    it("puts dated items oldest first, then idle leads by idle days, once per kind of work", () => {
        const out = workListRows([
            { lead_id: "1", dealer: "Idle Co", city: null, what: "Idle 9 working days", due: null, days: 9 },
            { lead_id: "2", dealer: "Late Co", city: "Pune", what: "Follow-up overdue", due: "2026-10-10", days: 7 },
            { lead_id: "2", dealer: "Late Co", city: "Pune", what: "Follow-up overdue", due: "2026-10-10", days: 7 },
            { lead_id: "3", dealer: "Today Co", city: "Delhi", what: "Visit today", due: "2026-10-17", days: 0 },
        ]);
        expect(out.leadIds).toEqual(["2", "3", "1"]);
        expect(out.rows[2]).toEqual(["Idle Co", "—", "Idle 9 working days", "—", 9]);
        expect(out.more).toBe(0);
    });
    it("caps the list and says how many more", () => {
        const many = Array.from({ length: 35 }, (_, i) => ({
            lead_id: String(i), dealer: `D${i}`, city: null, what: "Idle", due: null, days: i,
        }));
        const out = workListRows(many);
        expect(out.rows).toHaveLength(30);
        expect(out.more).toBe(5);
    });
});

describe("row links", () => {
    it("link the first cell in the HTML and print the URL in the text part", () => {
        const kind = {
            id: "my_day", label: "My day", description: "", settingsKey: "x", settingsHref: "/x",
            ctaHref: "/inside-sales", ctaLabel: "Open", sections: [{ key: "work_list", label: "", hint: "", group: "backlog" }],
            collect: async () => ({ ok: true, figures: { activity: [], backlog: [] } }),
            collectDetail: async () => ({ ok: true, detail: {} }),
        } as never;
        const table = {
            key: "work_list", title: "My work list", columns: ["Dealer", "City"], rows: [["A&B Motors", "Pune"]],
            rowLinks: ["https://crm.example/inside-sales/lead/L1"],
        };
        for (const masthead of [undefined, { title: "t", audience: "a", dataAsOf: "d", eyebrow: "e", dayHeading: "h", intro: "i", footer: "f" }]) {
            const { html, text } = buildDigestEmail({
                kind, to: ["x@y.z"], slot: "morning", istDay: "2026-10-16",
                figures: { activity: [], backlog: [], tables: [table], masthead },
            });
            expect(html).toContain(`href="https://crm.example/inside-sales/lead/L1"`);
            expect(html).toContain("A&amp;B Motors</a>");
            expect(text).toContain("A&B Motors | Pune — https://crm.example/inside-sales/lead/L1");
        }
    });
});

describe("role switches (settings)", () => {
    it("keep only the kind's own role keys and default from them", async () => {
        const { normalizeSettings, defaultSettings } = await import("../schedule");
        const base = defaultSettings([{ key: "s", label: "", hint: "", group: "activity" }], {
            enabled: false,
            recipients: [],
            roles: { inside_sales_rep: false, asm: false },
        });
        const next = normalizeSettings({ roles: { asm: true, ceo: true }, recipients: [] }, [{ key: "s", label: "", hint: "", group: "activity" }], base);
        expect(next.roles).toEqual({ inside_sales_rep: false, asm: true });
        expect(next.recipients).toEqual([]);
    });
});
