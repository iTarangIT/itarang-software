import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

const { fit, fmtDate, leadRow, renderTurn, renderLeadCard, renderLeadReport, whatsappText, RENDER_LIMITS, SORRY } = await import("../render");
const { encodeMore, decodeMore, nextPageFollowUp, renderProducts, renderProductPicked, productRow } = await import("../render");
const { fmtDay } = await import("@/lib/assistant/format");
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
    status_label: "Under Discussion",
    interest: "hot",
    phone: "9876543210",
    last_activity_at: "2026-09-30T06:30:00.000Z",
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
    it("title = shop (≤24), description = status · interest · next date · phone (≤72), id = ast:lead:<id>", () => {
        const r = leadRow(lead());
        expect(r.id).toBe("ast:lead:DL-1727890123456-a1b2c3d4");
        expect(r.title).toBe("ABC Traders");
        expect(r.description).toMatch(/^Under.Discussion · hot · Sat 26 Sep · 9876543210$/i);
    });

    it("a long description is cut BEFORE the phone, so the phone always shows", () => {
        const r = leadRow(lead({ status: "Awaiting_Customer_Decision".repeat(3), interest: "hot hot hot hot", phone: "+919876543210" }));
        expect(within(r.description!, 72)).toBe(true);
        expect(r.description!.endsWith(" · +919876543210")).toBe(true);
        expect(leadRow(lead({ status: null, interest: null, next_date: null })).description).toBe("9876543210");
    });

    it("truncates long shops and descriptions; falls back shop → dealer → id", () => {
        const r = leadRow(lead({ shop_name: "Shree Ganesh Battery & Inverter Solutions Pvt Ltd", status: "Awaiting_Customer_Decision", next_date: "2026-09-26T05:30:00.000Z" }));
        expect(within(r.title, 24)).toBe(true);
        expect(r.title.endsWith("…")).toBe(true);
        expect(within(r.description!, 72)).toBe(true);
        expect(leadRow(lead({ shop_name: null })).title).toBe("Ramesh");
        expect(leadRow(lead({ shop_name: " ", dealer_name: null })).title).toBe("DL-1727890123456-a1b2c3…");
        expect(leadRow(lead({ status: null, interest: null, next_date: null, phone: null })).description).toBeUndefined();
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

    it("IST ISO strings (+05:30, what tools now send) render the same instant as their UTC form", () => {
        expect(fmtDate("2026-09-25T11:00:00+05:30")).toBe("Fri 25 Sep, 11:00");
        expect(fmtDate("2026-09-26T00:30:00+05:30")).toBe(fmtDate("2026-09-25T19:00:00.000Z"));
        expect(fmtDay("2026-09-30T12:00:00+05:30")).toBe(fmtDay("2026-09-30T06:30:00.000Z"));
        // Just after IST midnight is already the next IST day.
        expect(fmtDay("2026-10-01T00:10:00+05:30")).toMatch(/1 Oct/);
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
        expect(p.body).toBe("Today's Schedule: 14 · showing 1–10\nAaj 14 visits hain.\n\nAll 14: https://crm.itarang.com/asm");
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

    const report = (n: number, total = n, over: Partial<LeadSummary> = {}): ToolResult => ({
        kind: "lead_report",
        title: "Hot leads",
        definition: "open leads you own, by current temperature; age = days since it became Hot",
        rows: Array.from({ length: n }, (_, i) => ({ ...lead({ id: `DL-${i}`, shop_name: `Shop ${i + 1}`, ...over }), age_days: i + 1 })),
        total,
        crm_url: "https://crm.itarang.com/asm/performance",
    });

    it("lead_report: text built from the rows — exact total, phone, status, ageing, last activity; model gives one line", () => {
        const p = renderTurn({ text: "Aapke 3 hot leads hain.\nShop 1 ... (model retyping)", results: [{ tool: "my_leads_by_temperature", result: report(3) }] });
        expect(p.kind).toBe("text");
        if (p.kind !== "text") return;
        expect(p.body).toBe(
            "Aapke 3 hot leads hain.\n\n*Hot leads — 3*\n(open leads you own, by current temperature; age = days since it became Hot)\n\n" +
                "1. Shop 1 (Pune) · 9876543210 · Under Discussion · Hot 1 day · last activity Wed 30 Sep\n" +
                "2. Shop 2 (Pune) · 9876543210 · Under Discussion · Hot 2 days · last activity Wed 30 Sep\n" +
                "3. Shop 3 (Pune) · 9876543210 · Under Discussion · Hot 3 days · last activity Wed 30 Sep",
        );
    });

    it("lead_report: more leads than rows → '+N more' with the link; the heading keeps the exact total", () => {
        const p = renderTurn({ text: "", results: [{ tool: "my_leads_by_temperature", result: report(10, 14) }] });
        expect(p.kind === "text" && p.body).toContain("*Hot leads — 14*");
        expect(p.kind === "text" && p.body).toMatch(/\+4 more: https:\/\/crm\.itarang\.com\/asm\/performance$/);
    });

    it("lead_report: rows that overflow 2,000 chars are dropped into '+N more', never cut mid-count", () => {
        const long = report(10, 10, { city: "Kanpur Dehat Industrial Area Phase Two ".repeat(3), status: "Awaiting_Customer_Decision", shop_name: "Shree Ganesh Battery & Inverter Solutions Pvt Ltd ".repeat(2) });
        const body = renderLeadReport(long as Extract<ToolResult, { kind: "lead_report" }>, "");
        expect(within(body, RENDER_LIMITS.report)).toBe(true);
        const shown = body.split("\n").filter((l) => /^\d+\. /.test(l)).length;
        expect(shown).toBeLessThan(10);
        expect(body).toContain(`+${10 - shown} more: https://crm.itarang.com/asm/performance`);
        expect(body).toContain("*Hot leads — 10*");
    });

    it("lead_report with no leads says so; a lead with no touchpoint says 'no activity yet'", () => {
        const none = renderTurn({ text: "", results: [{ tool: "my_leads_by_temperature", result: report(0, 0) }] });
        expect(none.kind === "text" && none.body).toContain("*Hot leads — 0*");
        expect(none.kind === "text" && none.body).toContain("None right now.");
        const fresh = renderTurn({ text: "", results: [{ tool: "my_leads_by_temperature", result: report(1, 1, { last_activity_at: null }) }] });
        expect(fresh.kind === "text" && fresh.body).toContain("Hot 1 day · no activity yet");
    });

    it("the newest of a list and a lead_report in one turn is what is shown", () => {
        const reportLast = renderTurn({ text: "", results: [{ tool: "my_queue", result: leads(3) }, { tool: "my_leads_by_temperature", result: report(2) }] });
        expect(reportLast.kind).toBe("text");
        const listLast = renderTurn({ text: "", results: [{ tool: "my_leads_by_temperature", result: report(2) }, { tool: "my_queue", result: leads(3) }] });
        expect(listLast.kind).toBe("list");
    });

    it("list body: the first line is OUR total; a model line with a wrong count is dropped, a right one kept", () => {
        const wrong = renderTurn({ text: "Aapke 5 visits hain.", results: [{ tool: "my_queue", result: leads(3, 7) }] });
        expect(wrong.kind === "list" && wrong.body).toBe("Today's Schedule: 7 · showing 1–3\n\nAll 7: https://crm.itarang.com/asm");
        const right = renderTurn({ text: "Aapke 7 visits hain.\nShop details below", results: [{ tool: "my_queue", result: leads(3, 7) }] });
        expect(right.kind === "list" && right.body).toBe("Today's Schedule: 7 · showing 1–3\nAapke 7 visits hain.\n\nAll 7: https://crm.itarang.com/asm");
        const cands = renderTurn({
            text: "I found 3 leads.",
            results: [{ tool: "search_lead", result: { kind: "candidates", question: "Which ABC?", rows: [lead({ id: "A" }), lead({ id: "B" })] } }],
        });
        expect(cands.kind === "list" && cands.body).toBe("Which ABC?");
    });

    it("every lead_report of the turn renders (hot AND warm), each with its heading, within 2,000", () => {
        const warm: ToolResult = { ...(report(4, 6) as Extract<ToolResult, { kind: "lead_report" }>), title: "Warm leads" };
        const p = renderTurn({
            text: "3 hot aur 6 warm.\n1. Shop 1 retyped\nKal call karein.\nAapke 9 leads",
            results: [
                { tool: "my_leads_by_temperature", result: report(3) },
                { tool: "my_leads_by_temperature", result: warm },
            ],
        });
        expect(p.kind).toBe("text");
        if (p.kind !== "text") return;
        expect(p.body).toContain("*Hot leads — 3*");
        expect(p.body).toContain("*Warm leads — 6*");
        expect(within(p.body, RENDER_LIMITS.report)).toBe(true);
        // Kept: the lead-in (counts agree) and a non-row line. Dropped: a row repeat and a wrong count.
        expect(p.body.startsWith("3 hot aur 6 warm.\nKal call karein.\n\n")).toBe(true);
        expect(p.body).not.toContain("retyped");
        expect(p.body).not.toContain("Aapke 9");
    });

    it("a lead opened after a search wins over the list: the model's answer, or the card when it gave none", () => {
        const detail: ToolResult = { kind: "lead", lead: { id: "DL-1", shop_name: "ABC Traders", phone: "+919812345678", status: "New", owned_by_you: true, crm_url: "https://crm/x" } };
        const withText = renderTurn({ text: "ABC ka number +919812345678 hai.", results: [{ tool: "search_lead", result: leads(3) }, { tool: "get_lead_details", result: detail }] });
        expect(withText).toEqual({ kind: "text", body: "ABC ka number +919812345678 hai." });
        const noText = renderTurn({ text: "", stop: "cap", results: [{ tool: "search_lead", result: leads(3) }, { tool: "get_lead_details", result: detail }] });
        expect(noText.kind === "text" && noText.body).toContain("*ABC Traders*");
        expect(noText.kind === "text" && noText.body).toContain("Phone: +919812345678");
    });

    it("no 'Sorry' over good data: a cap / timeout / empty turn still shows what the tools answered", () => {
        for (const stop of ["cap", "timeout", "empty"] as const) {
            const list = renderTurn({ text: "", stop, results: [{ tool: "my_queue", result: leads(3, 3) }] });
            expect(list.kind).toBe("list");
            const rep = renderTurn({ text: "", stop, results: [{ tool: "my_leads_by_temperature", result: report(2) }] });
            expect(rep.kind === "text" && rep.body).toContain("*Hot leads — 2*");
            const q = renderTurn({ text: "", stop, results: [{ tool: "log_call", result: { kind: "question", question: "Interested hai ya nahi?" } }] });
            expect(q).toEqual({ kind: "text", body: "Interested hai ya nahi?" });
            const nf = renderTurn({ text: "", stop, results: [{ tool: "get_lead_details", result: { kind: "not_found" } }] });
            expect(nf).toEqual({ kind: "text", body: "I couldn't find that lead." });
            const dec = renderTurn({ text: "", stop, results: [{ tool: "mark_lost", result: { kind: "declined", reason: "Read-only for you.", crm_url: "https://crm/x" } }] });
            expect(dec).toEqual({ kind: "text", body: "Read-only for you.\nhttps://crm/x" });
            const empty = renderTurn({ text: "", stop, results: [{ tool: "my_queue", result: leads(0, 0) }] });
            expect(empty).toEqual({ kind: "text", body: "Today's Schedule: 0" });
        }
    });

    it("only when nothing answered: a per-cause sorry, never 'shorter message'", () => {
        expect(renderTurn({ text: "", stop: "timeout", results: [] })).toEqual({ kind: "text", body: SORRY.timeout });
        expect(renderTurn({ text: "", stop: "cap", results: [] })).toEqual({ kind: "text", body: SORRY.cap });
        expect(renderTurn({ text: "", stop: "empty", results: [] })).toEqual({ kind: "text", body: SORRY.empty });
        expect(SORRY.timeout).toMatch(/took too long/);
        for (const s of Object.values(SORRY)) expect(s).not.toMatch(/shorter/i);
    });

    it("a write held back by the one-change limit adds 'Next: …' to the card", () => {
        const preview: ToolResult = {
            kind: "preview",
            action_id: "act-1",
            preview: { title: "Log call — ABC", lines: [{ label: "Call", value: "Connected" }], resets_idle_clock: true, warning: null, needs_second_confirm: false, crm_url: "https://crm/x" },
        };
        const p = renderTurn({ text: "Tap Confirm to save.", results: [{ tool: "log_call", result: preview }], next: "Next: mark lost — ask again after you confirm." });
        expect(p.kind).toBe("buttons");
        expect(p.kind === "buttons" && p.body.endsWith("\nNext: mark lost — ask again after you confirm.")).toBe(true);
        expect(p.kind === "buttons" && within(p.body, RENDER_LIMITS.previewBody)).toBe(true);
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
            id: "DL-9", shop_name: "S", dealer_name: "D", city: "C", phone: "9876543210", last_touchpoint_at: new Date("2026-09-30T06:30:00Z"),
            lead_status: "Lost", interest_level: "cold",
            current_owner_id: "isr-1", current_owner_name: "Priya", next_follow_up_at: "2026-09-26T05:30:00.000Z",
            scheduled_date: "2026-09-27", visit_status: "scheduled", pan_number: "ABCDE1234F", gstin: "27ABCDE1234F1Z0",
        };
        const isr = toLeadSummary(row, { id: "isr-1", name: "P", role: "inside_sales_rep" });
        expect(isr.owned_by_you).toBe(true);
        // Phase B6: timestamps reach the model in IST.
        expect(isr.next_date).toBe("2026-09-26T11:00:00+05:30");
        expect(isr.phone).toBe("9876543210");
        expect(isr.last_activity_at).toBe("2026-09-30T12:00:00+05:30");
        expect(JSON.stringify(isr)).not.toMatch(/ABCDE1234F|pan|gstin/);
        const asm = toLeadSummary(row, { id: "asm-1", name: "R", role: "asm" });
        expect(asm.owned_by_you).toBe(false);
        expect(asm.next_date).toBe("2026-09-27");
        // Phase B3: a completed / cancelled visit is not the next date.
        expect(toLeadSummary({ ...row, visit_status: "completed" }, { id: "asm-1", name: "R", role: "asm" }).next_date).toBeNull();
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
        // Phase B5: the link opens the same range.
        expect(out.crm_url).toMatch(/\/asm\/performance\?from=2026-09-01&to=2026-09-25$/);
    });
});

describe("paging — total first, Next 10, the whole list reachable", () => {
    const paged = (n: number, total: number, page = 1, args: Record<string, string> = { tab: "my_open" }): ToolResult => ({
        kind: "leads",
        title: "My open leads",
        rows: Array.from({ length: n }, (_, i) => lead({ id: `DL-${page}-${i}` })),
        total,
        crm_url: "https://crm.itarang.com/inside-sales",
        paging: { page, page_size: 10, args },
    });

    it("encodeMore / decodeMore round-trip; ids fit Meta's 256", () => {
        const id = encodeMore("my_queue", { tab: "my_open", search: "x".repeat(60), interest: "hot" }, 2)!;
        expect(id.startsWith("ast:more:")).toBe(true);
        expect(id.length).toBeLessThanOrEqual(256);
        expect(decodeMore(id.slice("ast:more:".length))).toEqual({
            tool: "my_queue",
            args: { tab: "my_open", search: "x".repeat(60), interest: "hot" },
            page: 2,
        });
    });

    it("decodeMore refuses anything that isn't one of ours", () => {
        const b = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
        for (const bad of [
            "", "not-base64!", b(null), b([]), b({ t: "z", a: {}, p: 2 }), b({ t: "constructor", a: {}, p: 2 }),
            b({ t: "q", a: {}, p: 1 }), b({ t: "q", a: {}, p: 99 }), b({ t: "q", a: { tab: 5 }, p: 2 }),
            b({ t: "q", a: { page: "9" }, p: 2 }), b({ t: "q", a: [], p: 2 }),
        ]) {
            expect(decodeMore(bad), bad).toBeNull();
        }
        expect(encodeMore("get_lead_details", {}, 2)).toBeNull();
        expect(encodeMore("my_queue", { search: "y".repeat(400) }, 2)).toBeNull();
    });

    it("page 1 of 23: list of 10 with the total first, then a Next 10 message carrying the CRM link", () => {
        const p = renderTurn({ text: "", results: [{ tool: "my_queue", result: paged(10, 23) }] });
        expect(p.kind).toBe("list");
        if (p.kind !== "list") return;
        expect(p.rows).toHaveLength(10);
        expect(p.body.split("\n")[0]).toBe("My open leads: 23 · showing 1–10");
        expect(p.body).not.toContain("All 23"); // the link rides on the Next message
        const f = p.followUp!;
        expect(f.kind).toBe("buttons");
        if (f.kind !== "buttons") return;
        expect(f.body).toBe("Showing 1–10 of 23.\nAll 23 in the CRM: https://crm.itarang.com/inside-sales");
        expect(f.buttons).toHaveLength(1);
        expect(f.buttons[0].title).toBe("Next 10 ▶");
        expect(decodeMore(f.buttons[0].id.slice("ast:more:".length))).toEqual({ tool: "my_queue", args: { tab: "my_open" }, page: 2 });
    });

    it("page 2 of 23 offers the last 3; the last page has no Next and keeps the link in the body", () => {
        const p2 = renderTurn({ text: "", results: [{ tool: "my_queue", result: paged(10, 23, 2) }] });
        expect(p2.kind === "list" && p2.body.split("\n")[0]).toBe("My open leads: 23 · showing 11–20");
        expect(p2.kind === "list" && p2.followUp?.kind === "buttons" && p2.followUp.buttons[0].title).toBe("Next 3 ▶");
        const p3 = renderTurn({ text: "", results: [{ tool: "my_queue", result: paged(3, 23, 3) }] });
        expect(p3.kind === "list" && p3.followUp).toBeUndefined();
        expect(p3.kind === "list" && p3.body).toBe("My open leads: 23 · showing 21–23\n\nAll 23: https://crm.itarang.com/inside-sales");
    });

    it("a list that fits one page has no range and no Next", () => {
        const p = renderTurn({ text: "", results: [{ tool: "my_queue", result: paged(7, 7) }] });
        expect(p.kind === "list" && p.body).toBe("My open leads: 7");
        expect(p.kind === "list" && p.followUp).toBeUndefined();
    });

    it("past the last page says so instead of '0 leads'", () => {
        const p = renderTurn({ text: "", results: [{ tool: "my_queue", result: paged(0, 0, 4) }] });
        expect(p).toEqual({ kind: "text", body: "No more leads — that was the whole list." });
    });

    it("search candidates page too", () => {
        const r: ToolResult = {
            kind: "candidates", question: "14 leads match \"sharma\". Which one do you mean?",
            rows: Array.from({ length: 10 }, (_, i) => lead({ id: `C-${i}` })), total: 14, crm_url: "https://crm/x",
            paging: { page: 1, page_size: 10, args: { query: "sharma" } },
        };
        const p = renderTurn({ text: "", results: [{ tool: "search_lead", result: r }] });
        expect(p.kind === "list" && p.body.split("\n")[0]).toContain("(showing 1–10)");
        expect(p.kind === "list" && p.followUp?.kind === "buttons" && decodeMore(p.followUp.buttons[0].id.slice(9))?.tool).toBe("search_lead");
    });

    it("hot report: numbered from the page's first row; Next only when the whole page fit", () => {
        const report = (n: number, total: number, page: number): ToolResult => ({
            kind: "lead_report", title: "Hot leads", definition: "d",
            rows: Array.from({ length: n }, (_, i) => ({ ...lead({ id: `H-${i}`, shop_name: `Shop ${i}` }), age_days: 3 })),
            total, crm_url: "https://crm/perf", paging: { page, page_size: 10, args: { interest: "hot" } },
        });
        const p1 = renderTurn({ text: "", results: [{ tool: "my_leads_by_temperature", result: report(10, 25, 1) }] });
        expect(p1.kind).toBe("text");
        expect(p1.kind === "text" && p1.body).toContain("+15 more: https://crm/perf");
        expect(p1.kind === "text" && p1.followUp?.kind === "buttons" && p1.followUp.buttons[0].title).toBe("Next 10 ▶");
        const p2 = renderTurn({ text: "", results: [{ tool: "my_leads_by_temperature", result: report(10, 25, 2) }] });
        expect(p2.kind === "text" && p2.body).toContain("\n11. Shop 0");
        expect(p2.kind === "text" && p2.body).toContain("+5 more");
        // Two reports in one turn: no Next (they share the room), "+N more" links instead.
        const two = renderTurn({
            text: "",
            results: [
                { tool: "my_leads_by_temperature", result: report(10, 25, 1) },
                { tool: "my_leads_by_temperature", result: { ...(report(10, 12, 1) as Extract<ToolResult, { kind: "lead_report" }>), title: "Warm leads" } },
            ],
        });
        expect(two.kind === "text" && two.followUp).toBeUndefined();
        const past = renderTurn({ text: "", results: [{ tool: "my_leads_by_temperature", result: report(0, 0, 4) }] });
        expect(past.kind === "text" && past.body).toBe("No more hot leads — that was the whole list.");
    });

    it("my_queue pages are cut from the screen's own pages of 25 (page 3 = rows 21–30 spans two)", async () => {
        const { sliceScreenPages } = await import("@/lib/assistant/tools/read/myQueue");
        const screen = Array.from({ length: 60 }, (_, i) => i + 1);
        const asked: number[] = [];
        const fetchPage = async (p: number) => {
            asked.push(p);
            return screen.slice((p - 1) * 25, p * 25);
        };
        expect(await sliceScreenPages(0, fetchPage)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        expect(asked).toEqual([1]);
        asked.length = 0;
        expect(await sliceScreenPages(20, fetchPage)).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
        expect(asked).toEqual([1, 2]);
        expect(await sliceScreenPages(50, fetchPage)).toEqual([51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);
        expect(await sliceScreenPages(60, fetchPage)).toEqual([]);
    });

    it("nextPageFollowUp: nothing without paging or when rows were cut short", () => {
        expect(nextPageFollowUp("my_queue", { total: 30 }, 10)).toBeNull();
        expect(nextPageFollowUp("my_queue", { total: 30, paging: { page: 1, page_size: 10, args: {} } }, 7)).toBeNull();
    });

    // ── Products ──
    const product = (i: number, asset_type: "battery" | "charger" | "paraphernalia" = "battery") => ({
        product_id: `p-${i}`, asset_type, product_name: `LFP 51.2V ${100 + i}Ah`, model_id: `LFP-${i}`, detail: "51.20V · 105Ah · LFP",
    });
    const products = (n: number, total: number, args: Record<string, string> = {}, page = 1): ToolResult => ({
        kind: "products", rows: Array.from({ length: n }, (_, i) => product(i)), total, paging: { page, page_size: 10, args },
    });

    it("productRow: name, model · spec, id ast:prod:<type>:<id>, within limits", () => {
        const r = productRow({ ...product(1), product_name: "A very long battery name that will not fit", detail: "d".repeat(200) });
        expect(r.id).toBe("ast:prod:battery:p-1");
        expect(within(r.title, RENDER_LIMITS.rowTitle)).toBe(true);
        expect(within(r.description!, RENDER_LIMITS.rowDescription)).toBe(true);
        expect(r.description!.startsWith("LFP-1 · ")).toBe(true);
    });

    it("whole catalogue bigger than a list → the product types first", () => {
        const p = renderTurn({ text: "Yeh rahe products: LFP …", results: [{ tool: "product_catalogue", result: products(10, 32) }] });
        expect(p.kind).toBe("buttons");
        expect(p.kind === "buttons" && p.buttons.map((b) => b.id)).toEqual(["ast:ptype:battery", "ast:ptype:charger", "ast:ptype:paraphernalia"]);
        expect(p.kind === "buttons" && p.buttons.every((b) => b.title.length <= 20)).toBe(true);
        expect(p.body).toContain("32 products");
    });

    it("a type with 16 → list of 10 to tap + Next 6; the model's typed product list is dropped", () => {
        const p = renderTurn({ text: "1. LFP 51.2V 100Ah\n2. …", results: [{ tool: "product_catalogue", result: products(10, 16, { asset_type: "battery" }) }] });
        expect(p.kind).toBe("list");
        if (p.kind !== "list") return;
        expect(p.header).toBe("Battery products");
        expect(p.body).toBe("Battery products: 16 · showing 1–10\nTap one to choose it.");
        expect(p.button).toBe("Choose product");
        expect(p.rows.every((r) => r.id.startsWith("ast:prod:battery:"))).toBe(true);
        expect(p.followUp?.kind === "buttons" && p.followUp.buttons[0].title).toBe("Next 6 ▶");
        expect(p.followUp?.kind === "buttons" && decodeMore(p.followUp.buttons[0].id.slice(9))).toEqual({
            tool: "product_catalogue", args: { asset_type: "battery" }, page: 2,
        });
    });

    it("a small catalogue or a searched query → straight to the list; one clear match → the model's answer", () => {
        expect(renderTurn({ text: "", results: [{ tool: "product_catalogue", result: products(8, 8) }] }).kind).toBe("list");
        expect(renderTurn({ text: "", results: [{ tool: "product_catalogue", result: products(10, 12, { query: "lfp" }) }] }).kind).toBe("list");
        const one = renderTurn({ text: "LFP 51.2V 100Ah mila. Kitni quantity?", results: [{ tool: "product_catalogue", result: products(1, 1, { query: "100ah" }) }] });
        expect(one).toEqual({ kind: "text", body: "LFP 51.2V 100Ah mila. Kitni quantity?" });
        expect(renderTurn({ text: "", results: [{ tool: "product_catalogue", result: products(1, 1, { query: "100ah" }) }] }).kind).toBe("list");
    });

    it("no match / past the end say so", () => {
        expect(renderProducts(products(0, 0, { query: "zzz" }) as Extract<ToolResult, { kind: "products" }>).body).toContain("No product");
        expect(renderProducts(products(0, 16, { asset_type: "battery" }, 3) as Extract<ToolResult, { kind: "products" }>).body).toContain("No more products");
    });

    it("a write preview still wins over a product list in the same turn", () => {
        const preview: ToolResult = {
            kind: "preview", action_id: "a1",
            preview: { title: "Quote — ABC", lines: [], resets_idle_clock: false, warning: null, needs_second_confirm: false, crm_url: "u" },
        };
        const p = renderTurn({ text: "", results: [{ tool: "product_catalogue", result: products(3, 3) }, { tool: "create_quote", result: preview }] });
        expect(p.kind).toBe("buttons");
    });

    it("renderProductPicked: names the product and asks for quantity + price; gone → says so", () => {
        const p = renderProductPicked(product(5));
        expect(p.body).toContain("LFP 51.2V 105Ah (LFP-5) chosen");
        expect(p.body).toMatch(/quantity/i);
        expect(renderProductPicked(null).body).toContain("no longer");
    });
});
