import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

const { fit, fmtDate, leadRow, renderTurn, renderLeadCard, whatsappText, RENDER_LIMITS } = await import("../render");
const { normalizeSearch } = await import("@/lib/assistant/tools/read/searchLead");
const { shapeNumbers, numbersInputs, METRIC_DEFINITIONS } = await import("@/lib/assistant/tools/read/myNumbers");
const { toLeadSummary } = await import("@/lib/assistant/tools/leads");
import type { LeadSummary, ToolResult } from "@/lib/assistant/types";

const cp = (s: string) => [...s].length;
const within = (s: string, max: number) => s.length <= max && cp(s) <= max;

const lead = (over: Partial<LeadSummary> = {}): LeadSummary => ({
    id: "DL-1727890123456-a1b2c3d4",
    shop_name: "ABC Traders",
    dealer_name: "Ramesh",
    city: "Pune",
    status: "Under_Discussion",
    interest: "hot",
    owner_name: "Rahul",
    owned_by_you: true,
    next_date: "2026-09-26",
    crm_url: "https://crm.itarang.com/asm/lead/DL-1727890123456-a1b2c3d4",
    ...over,
});

describe("fit — limits never exceeded, graphemes never split", () => {
    it("keeps text at exactly the limit; cuts one over with …", () => {
        expect(fit("x".repeat(24), 24)).toBe("x".repeat(24));
        const cut = fit("x".repeat(25), 24);
        expect(cut).toBe("x".repeat(23) + "…");
        expect(cp(cut)).toBe(24);
    });

    for (const max of [24, 72, 900, 1000]) {
        it(`${max}: ASCII, emoji, Devanagari, flags and ZWJ families all fit`, () => {
            for (const unit of ["a", "🙂", "नमस्ते ", "🇮🇳", "👨‍👩‍👧", "क्षि"]) {
                const s = unit.repeat(max);
                const out = fit(s, max);
                expect(within(out, max), `${unit} @${max}: ${out.length}/${cp(out)}`).toBe(true);
                // No lone surrogates and no half grapheme at the cut.
                expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
                const body = out.endsWith("…") ? out.slice(0, -1).trimEnd() : out;
                if (unit.trim().length > 0 && unit !== "a") expect(s.startsWith(body)).toBe(true);
            }
        });
    }
});

describe("leadRow", () => {
    it("title = shop (≤24), description = status · interest · next date (≤72), id = ast:lead:<id>", () => {
        const r = leadRow(lead());
        expect(r).toEqual({
            id: "ast:lead:DL-1727890123456-a1b2c3d4",
            title: "ABC Traders",
            description: "Under Discussion · hot · Sat 26 Sep",
        });
    });

    it("truncates long shops and descriptions; falls back shop → dealer → id", () => {
        const r = leadRow(lead({ shop_name: "Shree Ganesh Battery & Inverter Solutions Pvt Ltd", status: "Awaiting_Customer_Decision", next_date: "2026-09-26T05:30:00.000Z" }));
        expect(within(r.title, 24)).toBe(true);
        expect(r.title.endsWith("…")).toBe(true);
        expect(within(r.description!, 72)).toBe(true);
        expect(leadRow(lead({ shop_name: null })).title).toBe("Ramesh");
        expect(leadRow(lead({ shop_name: " ", dealer_name: null })).title).toBe("DL-1727890123456-a1b2c3…");
        expect(leadRow(lead({ status: null, interest: null, next_date: null })).description).toBeUndefined();
    });

    it("Devanagari and emoji shop names stay within 24", () => {
        const r = leadRow(lead({ shop_name: "श्री गणेश बैटरी एंड इन्वर्टर सॉल्यूशंस 🔋🔋🔋" }));
        expect(within(r.title, 24)).toBe(true);
    });
});

describe("fmtDate (IST)", () => {
    it("dates and timestamps render as IST day (and time)", () => {
        expect(fmtDate("2026-09-26")).toBe("Sat 26 Sep");
        expect(fmtDate("2026-09-25T05:30:00.000Z")).toBe("Fri 25 Sep, 11:00");
        expect(fmtDate(null)).toBeNull();
    });
});

describe("renderTurn", () => {
    const leads = (n: number, total = n): ToolResult => ({
        kind: "leads", title: "Today's Schedule", rows: Array.from({ length: n }, (_, i) => lead({ id: `DL-${i}` })), total,
        crm_url: "https://crm.itarang.com/asm",
    });

    it("UC-06: a queue with 2+ rows becomes a list (≤10 rows, header, button, link to all)", () => {
        const p = renderTurn({ text: "Aaj 14 visits hain.", results: [{ tool: "my_queue", result: leads(10, 14) }] });
        expect(p.kind).toBe("list");
        if (p.kind !== "list") return;
        expect(p.rows).toHaveLength(10);
        expect(p.header).toBe("Today's Schedule");
        expect(p.button.length).toBeLessThanOrEqual(RENDER_LIMITS.listButton);
        expect(p.body).toBe("Aaj 14 visits hain.\n\nAll 14: https://crm.itarang.com/asm");
        expect(p.rows.every((r) => r.id.startsWith("ast:lead:"))).toBe(true);
    });

    it("two same-name dealers: candidates always render as a list, never a guess", () => {
        const p = renderTurn({
            text: "",
            results: [{ tool: "search_lead", result: { kind: "candidates", question: "2 leads match \"ABC\". Which one do you mean?", rows: [lead({ id: "A" }), lead({ id: "B" })] } }],
        });
        expect(p.kind === "list" && p.rows.map((r) => r.id)).toEqual(["ast:lead:A", "ast:lead:B"]);
        expect(p.kind === "list" && p.body).toContain("Which one");
    });

    it("a single lead or no list result → text, ≤1000, markdown cleaned", () => {
        const one = renderTurn({ text: "**ABC Traders** — hot", results: [{ tool: "my_queue", result: leads(1) }] });
        expect(one).toEqual({ kind: "text", body: "*ABC Traders* — hot" });
        const long = renderTurn({ text: "y".repeat(3000), results: [] });
        expect(long.kind === "text" && within(long.body, 1000)).toBe(true);
    });

    it("list body is capped at 1,024 even with a long model reply", () => {
        const p = renderTurn({ text: "z".repeat(2000), results: [{ tool: "my_queue", result: leads(3, 40) }] });
        expect(p.kind === "list" && within(p.body, RENDER_LIMITS.listBody)).toBe(true);
    });

    it("whatsappText strips markdown the renderer must not send", () => {
        expect(whatsappText("## Title\n| a | b |\n|---|---|\nsee [CRM](https://x.y/z)")).toBe("Title\n\nsee CRM: https://x.y/z");
    });
});

describe("renderLeadCard", () => {
    const detail = {
        id: "DL-1", shop_name: "ABC Traders", dealer_name: "Ramesh", phone: "+919812345678", city: "Pune",
        status: "Under_Discussion", interest: "hot", owner_name: "Rahul", owned_by_you: false,
        next_follow_up_at: "2026-09-26T05:30:00.000Z", last_activity_at: "2026-09-24T09:00:00.000Z",
        recent_touchpoints: [{ at: "2026-09-24T09:00:00.000Z", type: "inside_sales_call", call_status: "connected", remarks: "Wants 10 units\\nat ₹X" }],
        recent_visits: [{ visited_on: "2026-09-20", status: "visited", outcome: "productive" }],
        crm_url: "https://crm.itarang.com/inside-sales/lead/DL-1",
    };

    it("says read-only when the user doesn't own it, and always ends with the CRM link", () => {
        const card = renderLeadCard(detail);
        expect(card).toContain("*ABC Traders*");
        expect(card).toContain("Owner: Rahul (read-only for you)");
        expect(card).toContain("Next follow-up: Sat 26 Sep, 11:00");
        expect(card.endsWith("https://crm.itarang.com/inside-sales/lead/DL-1")).toBe(true);
        expect(within(card, RENDER_LIMITS.text)).toBe(true);
    });

    it("stays within 1,000 with the link intact when the history is huge", () => {
        const card = renderLeadCard({ ...detail, recent_touchpoints: Array(5).fill({ at: null, type: "note", remarks: "r".repeat(900) }) });
        expect(within(card, RENDER_LIMITS.text)).toBe(true);
        expect(card.endsWith(detail.crm_url)).toBe(true);
    });
});

describe("tool helpers", () => {
    it("normalizeSearch: phone-shaped input → last 10 digits; names untouched", () => {
        expect(normalizeSearch("+91 98123-45678")).toBe("9812345678");
        expect(normalizeSearch("98123 45678")).toBe("9812345678");
        expect(normalizeSearch("Sharma Battery House")).toBe("Sharma Battery House");
        expect(normalizeSearch("12345")).toBe("12345");
    });

    it("toLeadSummary: allowlist only, ownership from the SERVER's user, role's next date", () => {
        const row = {
            id: "DL-9", shop_name: "S", dealer_name: "D", city: "C", lead_status: "Lost", interest_level: "cold",
            current_owner_id: "isr-1", current_owner_name: "Priya", next_follow_up_at: "2026-09-26T05:30:00.000Z",
            scheduled_date: "2026-09-27", pan_number: "ABCDE1234F", gstin: "27ABCDE1234F1Z5",
        };
        const isr = toLeadSummary(row, { id: "isr-1", name: "P", role: "inside_sales_rep" });
        expect(isr.owned_by_you).toBe(true);
        expect(isr.next_date).toBe("2026-09-26T05:30:00.000Z");
        expect(JSON.stringify(isr)).not.toMatch(/ABCDE1234F|pan|gstin/);
        const asm = toLeadSummary(row, { id: "asm-1", name: "R", role: "asm" });
        expect(asm.owned_by_you).toBe(false);
        expect(asm.next_date).toBe("2026-09-27");
        expect(asm.crm_url).toMatch(/\/asm\/lead\/DL-9$/);
    });

    it("my_numbers: month-to-date range in IST; last month = the whole previous month", () => {
        const u = { id: "u", name: "N", role: "asm" as const };
        const now = new Date("2026-09-30T20:00:00Z"); // 1 Oct 01:30 IST
        expect(numbersInputs(u, "this_month", now)).toMatchObject({ from: "2026-10-01", to: "2026-10-01", month: "2026-10" });
        expect(numbersInputs(u, "last_month", now)).toMatchObject({ from: "2026-09-01", to: "2026-09-30", month: "2026-09" });
        expect(numbersInputs(u, "this_month", now).dashboardInput).toMatchObject({ spoc_id: "u", granularity: "day" });
    });

    it("my_numbers: only pushed/accepted targets are shown, each with its definition", () => {
        const progress = { monthly_target: 40, mtd_target: 30, actual: 24, pct_of_mtd: 80, remaining: 16, required_per_day: 2, rag: "amber" as const };
        const t = (metric: string, status: string) => ({ metric, metric_label: metric, status, progress }) as never;
        const dash = {
            as_of_date: "2026-09-25",
            totals: { visits: 24, unique_visits: 20, new_visits: 5, calls: 3, dealers_called: 3, converted: 1, new_hot: 0, hot_converted: 0 },
            snapshot: { visits_yesterday: 1, calls_yesterday: 0, planned_visits_today: 2, planned_visits_next_7_days: 6 },
            interest: { rows: [{ interest_level: "hot", total: 4 }, { interest_level: "warm", total: 2 }, { interest_level: "cold", total: 9 }], ageing_basis: "" },
        } as never;
        const out = shapeNumbers({ id: "u", name: "N", role: "asm" }, "this_month", { from: "2026-09-01", to: "2026-09-25" }, dash,
            [t("dealer_visits", "accepted"), t("revenue", "draft"), t("scrap_deals", "pushed")]);
        expect((out.targets as { metric: string }[]).map((x) => x.metric)).toEqual(["dealer_visits", "scrap_deals"]);
        expect((out.targets as { definition: string }[])[0].definition).toBe(METRIC_DEFINITIONS.dealer_visits);
        expect(out.interest).toEqual({ hot: 4, warm: 2, cold: 9 });
        expect(out.planned_visits).toEqual({ today: 2, next_7_days: 6 });
        expect(out.crm_url).toMatch(/\/asm\/performance$/);
    });
});
