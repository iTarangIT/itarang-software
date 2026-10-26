import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// Gap table C — quotes & commercials: product_catalogue, quote_status,
// create_quote, send_quote. Every CRM writer and lookup is mocked — these tests
// pin what each tool PROPOSES and refuses, that the OEM floor never reaches a
// rep, and that each applier calls the shared writer (createLeadCommercial /
// sendApprovedQuotation) the screen's routes use.

const dbRows: Record<string, unknown>[] = [];
const execute = vi.fn(async (_q?: unknown) => dbRows);
vi.mock("@/lib/db", () => ({ db: { execute } }));
const findLeadInScope = vi.fn();
vi.mock("../scope", async (orig) => ({ ...(await orig<typeof import("../scope")>()), findLeadInScope }));
const createPending = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ id: "act-1", expiresAt: new Date() }));
vi.mock("../actions", async (orig) => ({ ...(await orig<typeof import("../actions")>()), createPending }));

const listOemCatalogue = vi.fn();
const loadLiveOemPrices = vi.fn();
vi.mock("@/lib/leads/oemPrices", async (orig) => ({
    ...(await orig<typeof import("@/lib/leads/oemPrices")>()),
    listOemCatalogue,
    loadLiveOemPrices,
}));
const loadLatestQuote = vi.fn();
vi.mock("../tools/quotes", async (orig) => ({ ...(await orig<typeof import("../tools/quotes")>()), loadLatestQuote }));
const loadQuote = vi.fn();
vi.mock("@/lib/leads/quoteSendGate", async (orig) => ({
    ...(await orig<typeof import("@/lib/leads/quoteSendGate")>()),
    loadQuote,
}));
const sendApprovedQuotation = vi.fn();
vi.mock("@/lib/leads/sendQuotation", () => ({ sendApprovedQuotation }));
const withdrawWriter = vi.fn();
vi.mock("@/lib/leads/withdrawQuote", async (orig) => ({
    ...(await orig<typeof import("@/lib/leads/withdrawQuote")>()),
    withdrawQuote: withdrawWriter,
}));
const afterCommit = vi.fn(async () => ({ quote_number: "ITQ-2026-0007" }));
const createLeadCommercial = vi.fn();
class CommercialInputError extends Error {
    constructor(message: string, readonly status = 409) {
        super(message);
    }
}
vi.mock("@/lib/leads/createCommercial", () => ({ createLeadCommercial, CommercialInputError }));
// ID 186: is the dealer already onboarded? Default: a brand-new dealer.
const isDealerOnboarded = vi.fn();
vi.mock("@/lib/leads/dealerOnboarded", () => ({ isDealerOnboarded }));
const NEW_DEALER = { onboarded: false, reason: "New dealer", approvedOnboarding: null, batteryInvoice: null };
const ONBOARDED = { onboarded: true, reason: "Already onboarded: battery invoice X", approvedOnboarding: null, batteryInvoice: null };

const { toolsFor, toolNamesFor } = await import("../registry");
const { APPLIERS } = await import("../appliers");
const { QuotationNotSendableError } = await import("@/lib/leads/quoteSendGate");
const { quoteTotal } = await import("../tools/write/createQuote");
const { renderTapOutcome, renderTurn } = await import("@/lib/wa-assistant/render");
const { statusLabel } = await import("../format");
import type { AssistantUser, Preview, ToolContext } from "../types";
import type { ExecOutcome } from "../executor";

const ISR: AssistantUser = { id: "isr-1", name: "Priya", role: "inside_sales_rep" };
const ASM: AssistantUser = { id: "asm-1", name: "Rahul", role: "asm" };
const NOW = new Date("2026-09-26T06:30:00Z");
const TX = { tx: true } as never;
const ctx = (user: AssistantUser): ToolContext => ({ user, messageId: null, now: NOW, writesEnabled: true });
const lead = (over: Record<string, unknown> = {}) => ({
    id: "DL-7", shop_name: "ABC Traders", dealer_name: "Ramesh", phone: "9876543210", city: "Pune", state: "Maharashtra",
    current_owner_id: "isr-1", asm_id: null, lead_status: "Under_Discussion", interest_level: "warm",
    next_follow_up_at: null, updated_at: new Date("2026-09-26T05:00:00Z"), owned: true, ...over,
});
const tool = (user: AssistantUser, name: string) => toolsFor(user.role, true).find((t) => t.name === name)!;
const run = async (user: AssistantUser, name: string, input: Record<string, unknown>) => {
    const t = tool(user, name);
    return t.run(ctx(user), t.schema.parse(input));
};
const stored = () =>
    createPending.mock.calls.at(-1)![0] as { plan: Record<string, unknown>; preview: Preview; tool: string; leadId: string | null };
const previewText = (p: Preview) => [p.title, ...p.lines.map((l) => `${l.label}: ${l.value}`), p.warning ?? ""].join("\n");

const CATALOGUE = [
    { asset_type: "battery", product_id: "b-105", model_id: "ITB-51105", product_name: "LFP 51.2V 105Ah", detail: "51.2V · 105Ah · LFP", oem_price: 41000, price_id: "pr-1" },
    { asset_type: "battery", product_id: "b-80", model_id: "ITB-5180", product_name: "LFP 51.2V 80Ah", detail: "51.2V · 80Ah · LFP", oem_price: 33000, price_id: "pr-2" },
    { asset_type: "charger", product_id: "c-10", model_id: "ITC-10A", product_name: "Charger 10A", detail: "fast", oem_price: 4500, price_id: "pr-3" },
];
const refsFor = (prices: Record<string, number>) =>
    new Map(Object.entries(prices).map(([k, v]) => [k, { price_id: `pr-${k}`, oem_price: v }]));
const quoteView = (over: Record<string, unknown> = {}) => ({
    commercial_id: "com-3", version_no: 3, event_type: "quote_issue", approval_status: "approved", approval_mode: "auto",
    rejection_reason: null, total: 99120, quote_number: "ITQ-2026-0003", pdf_ready: true,
    product_lines: [{ product_id: "b-105", asset_type: "battery", product_name: "LFP 51.2V 105Ah", quantity: 2, unit_price: 42000 }],
    credit_terms: "30 days", delivery_terms: null, warranty_terms: null, payment_method: "cash", deal_notes: null,
    dealer_decision: null, dealer_decision_at: null, created_at: "2026-09-20T10:00:00.000Z", ...over,
});
const sendRow = (over: Record<string, unknown> = {}) => ({
    commercial_id: "com-3", dealer_lead_id: "DL-7", approval_status: "approved", quote_number: "ITQ-2026-0003",
    quote_pdf_url: "https://s3/q.pdf", quote_pdf_error: null, version_no: 3, dealer_name: "Ramesh",
    dealer_phone: "9876543210", dealer_email: null, quote_total: "99120", dealer_decision: null,
    dealer_decision_at: null, dealer_decision_via: null, dealer_decision_note: null, ...over,
});

beforeEach(() => {
    vi.clearAllMocks();
    dbRows.length = 0;
    findLeadInScope.mockResolvedValue(lead());
    listOemCatalogue.mockResolvedValue(CATALOGUE);
    loadLiveOemPrices.mockResolvedValue(refsFor({ "battery:b-105": 41000, "charger:c-10": 4500 }));
    loadLatestQuote.mockResolvedValue(null);
    loadQuote.mockResolvedValue(sendRow());
    isDealerOnboarded.mockResolvedValue(NEW_DEALER);
    createLeadCommercial.mockResolvedValue({
        commercialId: "com-4", versionNo: 4, approvalStatus: "approved", autoApproved: true, evaluation: null, afterCommit,
    });
});

describe("registry", () => {
    it("both roles get the quote tools; off the pilot list only the two reads", () => {
        for (const u of [ISR, ASM]) {
            const names = toolNamesFor(u.role, true);
            for (const n of ["product_catalogue", "quote_status", "create_quote", "send_quote", "withdraw_quote"]) expect(names, `${u.role} ${n}`).toContain(n);
            const readOnly = toolNamesFor(u.role, false);
            expect(readOnly).toContain("product_catalogue");
            expect(readOnly).toContain("quote_status");
            expect(readOnly).not.toContain("create_quote");
            expect(readOnly).not.toContain("send_quote");
            expect(readOnly).not.toContain("withdraw_quote");
        }
        expect(APPLIERS.create_quote).toBeDefined();
        expect(APPLIERS.send_quote).toBeDefined();
        expect(APPLIERS.withdraw_quote).toBeDefined();
    });
});

describe("product_catalogue", () => {
    it("matches every word across name / model / spec, and never carries a price", async () => {
        const r = await run(ISR, "product_catalogue", { query: "51.2v 105ah" });
        expect(r).toEqual({
            kind: "products",
            total: 1,
            rows: [{ product_id: "b-105", asset_type: "battery", product_name: "LFP 51.2V 105Ah", model_id: "ITB-51105", detail: "51.2V · 105Ah · LFP" }],
            paging: { page: 1, page_size: 10, args: { query: "51.2v 105ah" } },
        });
        const all = await run(ASM, "product_catalogue", {});
        expect(JSON.stringify(all)).not.toMatch(/oem_price|price_id|41000|33000|4500/);
        expect(await run(ISR, "product_catalogue", { asset_type: "charger" })).toMatchObject({ total: 1, rows: [{ product_id: "c-10" }] });
    });

    it("caps at 10 rows but reports the full total", async () => {
        listOemCatalogue.mockResolvedValue(
            Array.from({ length: 14 }, (_, i) => ({ ...CATALOGUE[0], product_id: `b-${i}`, product_name: `Battery ${i}` })),
        );
        const r = await run(ISR, "product_catalogue", { query: "battery" });
        expect(r).toMatchObject({ kind: "products", total: 14 });
        expect(r.kind === "products" && r.rows.length).toBe(10);
        // Page 2 = the remaining 4, same total, and the inputs to ask for it again.
        const p2 = await run(ISR, "product_catalogue", { query: "battery", page: 2 });
        expect(p2).toMatchObject({ kind: "products", total: 14, paging: { page: 2, page_size: 10, args: { query: "battery" } } });
        expect(p2.kind === "products" && p2.rows.map((x) => x.product_id)).toEqual(["b-10", "b-11", "b-12", "b-13"]);
    });
});

describe("create_quote", () => {
    const LINES = [{ product_id: "b-105", quantity: 2, unit_price: 42000 }];
    // ID 172: the deal card every quote states (no locked card on the lead here).
    const CARD = { onboarding_fee: 25000, batteries_per_month: 20, finance_files_per_month: 5 };
    const CASH = { payment_terms: "cash" as const, ...CARD };

    it("first quote, every line at or above reference → quote_issue, auto-approve forecast, no floor price shown", async () => {
        const r = await run(ISR, "create_quote", { lead_id: "DL-7", lines: LINES, payment_terms: "cash", ...CARD });
        expect(r).toMatchObject({ kind: "preview", action_id: "act-1" });
        const s = stored();
        expect(s.tool).toBe("create_quote");
        expect(s.plan).toMatchObject({
            lead_id: "DL-7",
            event_type: "quote_issue",
            final_price: 84000,
            // Customer finance is the writer's: finance files per month > 0.
            terms: { dealer_payment_terms: "cash", credit_days: null, customer_finance: true },
            deal_card: { onboarding_fee: 25000, fee_waived_reason: null, batteries_per_month: 20, finance_files_per_month: 5 },
            // Name, model and asset type are the catalogue's, not the model's.
            product_lines: [{ asset_type: "battery", product_id: "b-105", product_name: "LFP 51.2V 105Ah", model_id: "ITB-51105", unit_price: 42000, quantity: 2 }],
        });
        const text = previewText(s.preview);
        expect(s.preview.title).toBe("Quote — ABC Traders");
        expect(text).toContain("2 × LFP 51.2V 105Ah @ ₹42,000 = ₹84,000");
        expect(text).toContain("Total (before GST): ₹84,000");
        expect(text).toMatch(/Auto-approved on Confirm/);
        expect(text).toContain("Payment terms: Cash");
        expect(text).toContain("Customer finance (NBFC): Yes");
        expect(text).toContain("Onboarding fee: ₹25,000");
        expect(text).toContain("Batteries / month: 20");
        expect(text).toContain("Finance files / month: 5");
        // ID 75: saving the quote moves the lead (advanceLeadOnQuoteEvent) — work, so the idle clock resets.
        expect(s.preview.lines).toContainEqual({ label: "Status", value: `${statusLabel("Under_Discussion")} → ${statusLabel("Commercials_Explained")}` });
        // Warranty / delivery are the admin's standard terms, not the rep's.
        expect(text).toMatch(/Warranty: .+/);
        expect(text).toMatch(/Delivery: .+/);
        expect(s.preview.warning).toBeNull();
        expect(s.preview.resets_idle_clock).toBe(true);
        expect(text).not.toMatch(/41,000|41000/);
        // Judged at the turn's clock, against the resolved lines.
        expect(loadLiveOemPrices).toHaveBeenCalledWith(s.plan.product_lines, undefined, NOW);
    });

    it("credit terms → CEO approval even when every price clears (ID 73)", async () => {
        await run(ISR, "create_quote", { lead_id: "DL-7", lines: LINES, payment_terms: "credit", credit_days: 30, ...CARD });
        const s = stored();
        expect(s.plan.terms).toEqual({ dealer_payment_terms: "credit", credit_days: 30, customer_finance: true });
        expect(previewText(s.preview)).toMatch(/Goes to the CEO for approval/);
        expect(previewText(s.preview)).toContain("Payment terms: Credit — 30 days");
        expect(s.preview.warning).toMatch(/Needs CEO approval: credit terms \(30 days\)/);
    });

    it("payment terms are asked for, never assumed; credit needs its days", async () => {
        expect(await run(ISR, "create_quote", { lead_id: "DL-7", lines: LINES })).toEqual({
            kind: "question",
            question: "Payment terms for the dealer — cash, or credit (how many days)?",
        });
        expect(await run(ISR, "create_quote", { lead_id: "DL-7", lines: LINES, payment_terms: "credit" })).toEqual({
            kind: "question",
            question: "How many days of credit (1–180)?",
        });
        expect(createPending).not.toHaveBeenCalled();
    });

    it("a line below reference → CEO warning, still without the reference figure", async () => {
        await run(ASM, "create_quote", { lead_id: "DL-7", lines: [{ product_id: "b-105", quantity: 1, unit_price: 39000 }], ...CASH });
        const { preview } = stored();
        expect(previewText(preview)).toMatch(/Goes to the CEO for approval/);
        expect(preview.warning).toMatch(/Needs CEO approval: 1 line is below the reference price/);
        expect(previewText(preview)).not.toMatch(/41,000|41000|2,000/);
    });

    it("a product with no reference price also goes to the CEO", async () => {
        await run(ISR, "create_quote", { lead_id: "DL-7", lines: [{ product_id: "b-80", quantity: 1, unit_price: 99999 }], ...CASH });
        expect(stored().preview.warning).toMatch(/Needs CEO approval/);
    });

    it("an existing quote → quote_revision, titled and naming what it replaces", async () => {
        loadLatestQuote.mockResolvedValue(quoteView({ approval_status: "pending" }));
        await run(ISR, "create_quote", { lead_id: "DL-7", lines: LINES, ...CASH });
        const s = stored();
        expect(s.plan.event_type).toBe("quote_revision");
        expect(s.preview.title).toBe("Revised quote — ABC Traders");
        expect(previewText(s.preview)).toContain("Replaces: v3 (₹99,120) — Waiting for CEO approval");
    });

    it("missing quantity or price → a question, nothing proposed; never a guessed price", async () => {
        expect(await run(ISR, "create_quote", { lead_id: "DL-7", lines: [{ product_id: "b-105", quantity: 2 }] })).toEqual({
            kind: "question",
            question: "What price per unit (before GST) for LFP 51.2V 105Ah?",
        });
        expect(await run(ISR, "create_quote", { lead_id: "DL-7", lines: [{ product_id: "c-10", unit_price: 5000 }] })).toEqual({
            kind: "question",
            question: "How many Charger 10A?",
        });
        expect(createPending).not.toHaveBeenCalled();
    });

    it("an invented product id or a duplicated line → refused, nothing proposed", async () => {
        const r = await run(ISR, "create_quote", { lead_id: "DL-7", lines: [{ product_id: "made-up", quantity: 1, unit_price: 1 }] });
        expect(r.kind).toBe("declined");
        const dup = await run(ISR, "create_quote", { lead_id: "DL-7", lines: [...LINES, ...LINES] });
        expect(dup.kind).toBe("question");
        expect(createPending).not.toHaveBeenCalled();
    });

    it("not owned / out of scope / pilot off → no pending action", async () => {
        findLeadInScope.mockResolvedValue(lead({ owned: false, current_owner_id: "isr-2" }));
        expect((await run(ISR, "create_quote", { lead_id: "DL-7", lines: LINES })).kind).toBe("declined");
        findLeadInScope.mockResolvedValue(null);
        expect(await run(ISR, "create_quote", { lead_id: "DL-7", lines: LINES })).toEqual({ kind: "not_found" });
        const t = tool(ISR, "create_quote");
        const off = await t.run({ ...ctx(ISR), writesEnabled: false }, t.schema.parse({ lead_id: "DL-7", lines: LINES }));
        expect(off.kind).toBe("declined");
        expect(createPending).not.toHaveBeenCalled();
    });

    it("the total is exact in paise", () => {
        expect(quoteTotal([{ unit_price: 0.1, quantity: 1 }, { unit_price: 0.2, quantity: 1 }])).toBe(0.3);
        expect(quoteTotal([{ unit_price: 1999.99, quantity: 3 }])).toBe(5999.97);
    });

    it("the applier writes through createLeadCommercial on the executor's tx and defers the PDF to afterCommit", async () => {
        await run(ISR, "create_quote", { lead_id: "DL-7", lines: LINES, payment_terms: "credit", credit_days: 45, ...CARD, finance_files_per_month: 0 });
        const plan = APPLIERS.create_quote.schema.parse(stored().plan);
        const out = await APPLIERS.create_quote.apply({ tx: TX, user: ISR, step: 1 }, plan);
        expect(createLeadCommercial).toHaveBeenCalledWith(
            {
                leadId: "DL-7",
                actor: { id: "isr-1", name: "Priya", role: "inside_sales_rep" },
                body: expect.objectContaining({
                    event_type: "quote_issue",
                    final_price: 84000,
                    terms: { dealer_payment_terms: "credit", credit_days: 45, customer_finance: false },
                    deal_card: { onboarding_fee: 25000, fee_waived_reason: null, batteries_per_month: 20, finance_files_per_month: 0 },
                }),
                // ID 172: as the commercials route.
                requireDealCard: true,
            },
            { tx: TX },
        );
        expect(out).toMatchObject({ commercial_id: "com-4", quote_version: 4, approval_status: "approved", auto_approved: true });
        expect(afterCommit).not.toHaveBeenCalled();
        expect(await out.afterCommit!()).toEqual({ quote_number: "ITQ-2026-0007" });
    });
});

describe("create_quote — deal card (ID 172) and what the card says the quote does (ID 75)", () => {
    const LINES = [{ product_id: "b-105", quantity: 2, unit_price: 42000 }];

    it("asks for each deal-card answer in turn; a waived fee needs its reason; nothing proposed", async () => {
        const base = { lead_id: "DL-7", lines: LINES, payment_terms: "cash" };
        expect(await run(ISR, "create_quote", base)).toMatchObject({ kind: "question", question: expect.stringMatching(/onboarding fee/i) });
        expect(await run(ISR, "create_quote", { ...base, onboarding_fee: 0 })).toMatchObject({ question: expect.stringMatching(/why is it waived/i) });
        expect(await run(ISR, "create_quote", { ...base, onboarding_fee: 25000 })).toMatchObject({ question: expect.stringMatching(/batteries/i) });
        expect(await run(ISR, "create_quote", { ...base, onboarding_fee: 25000, batteries_per_month: 20 })).toMatchObject({
            question: expect.stringMatching(/loan/i),
        });
        expect(createPending).not.toHaveBeenCalled();
        await run(ISR, "create_quote", { ...base, onboarding_fee: 0, fee_waived_reason: "launch offer", batteries_per_month: 20, finance_files_per_month: 0 });
        expect(previewText(stored().preview)).toContain("Onboarding fee: Waived — launch offer");
        expect(previewText(stored().preview)).toContain("Customer finance (NBFC): No");
    });

    it("a LOCKED card is the one the quote carries — the rep is not asked, and the card says so", async () => {
        dbRows.push({
            commercial_id: "com-2", version_no: 2, approval_status: "approved", approved_by: "ceo-1", dealer_decision: null,
            card: { onboarding_fee: "15000", fee_waived_reason: null, expected_batteries_per_month: "30", expected_finance_files_per_month: "4" },
        });
        const r = await run(ISR, "create_quote", { lead_id: "DL-7", lines: LINES, payment_terms: "cash", onboarding_fee: 1 });
        expect(r.kind).toBe("preview");
        expect(stored().plan.deal_card).toEqual({ onboarding_fee: 15000, fee_waived_reason: null, batteries_per_month: 30, finance_files_per_month: 4 });
        const text = previewText(stored().preview);
        expect(text).toContain("Onboarding fee: ₹15,000 (locked: the CEO approved v2)");
        expect(text).toContain("Customer finance (NBFC): Yes");
    });

    it("a lead Awaiting field visit keeps its status; no status note, so the idle clock does not move", async () => {
        findLeadInScope.mockResolvedValue(lead({ lead_status: "Transferred_to_ASM" }));
        dbRows.push({ pre_transfer_status: "Under_Discussion" });
        await run(ISR, "create_quote", { lead_id: "DL-7", lines: LINES, payment_terms: "cash", onboarding_fee: 1000, batteries_per_month: 5, finance_files_per_month: 1 });
        const line = stored().preview.lines.find((l) => l.label === "Status")!;
        expect(line.value).toMatch(/unchanged until the visit; the visit then restores/);
        expect(stored().preview.resets_idle_clock).toBe(false);
        // Already past Commercials explained: no move, no reset.
        findLeadInScope.mockResolvedValue(lead({ lead_status: "Awaiting_Customer_Decision" }));
        dbRows.length = 0;
        await run(ISR, "create_quote", { lead_id: "DL-7", lines: LINES, payment_terms: "cash", onboarding_fee: 1000, batteries_per_month: 5, finance_files_per_month: 1 });
        expect(stored().preview.lines).toContainEqual({ label: "Status", value: "no change" });
        expect(stored().preview.resets_idle_clock).toBe(false);
    });

    // ID 186 (18 Oct): the same rule as Update commercials (dealCardRequired).
    it("a brand-new dealer: the card is asked, and the question says why", async () => {
        const r = await run(ISR, "create_quote", { lead_id: "DL-7", lines: LINES, payment_terms: "cash" });
        expect(r).toMatchObject({ kind: "question", question: expect.stringMatching(/^This dealer is not onboarded yet.*onboarding fee/i) });
        expect(isDealerOnboarded).toHaveBeenCalledWith("DL-7");
        expect(createPending).not.toHaveBeenCalled();
    });

    it("an onboarded dealer: ISR / ASM may skip the card; the preview says so and the applier does not require it", async () => {
        isDealerOnboarded.mockResolvedValue(ONBOARDED);
        for (const u of [ISR, ASM]) {
            const r = await run(u, "create_quote", { lead_id: "DL-7", lines: LINES, payment_terms: "cash" });
            expect(r.kind, u.role).toBe("preview");
            const s = stored();
            expect(s.plan.deal_card).toBeNull();
            expect(s.plan.terms).toMatchObject({ customer_finance: null });
            const text = previewText(s.preview);
            expect(text).toContain("Deal card: Skipped — dealer already onboarded");
            expect(text).not.toMatch(/Onboarding fee:/);
        }
        const plan = APPLIERS.create_quote.schema.parse(stored().plan);
        await APPLIERS.create_quote.apply({ tx: TX, user: ASM, step: 1 }, plan);
        expect(createLeadCommercial).toHaveBeenCalledWith(
            expect.objectContaining({ requireDealCard: false, body: expect.objectContaining({ deal_card: null }) }),
            { tx: TX },
        );
    });

    it("an onboarded dealer: a STARTED card must still be complete", async () => {
        isDealerOnboarded.mockResolvedValue(ONBOARDED);
        const r = await run(ISR, "create_quote", { lead_id: "DL-7", lines: LINES, payment_terms: "cash", onboarding_fee: 5000 });
        expect(r).toMatchObject({ kind: "question", question: expect.stringMatching(/batteries/i) });
    });

    it("a skipped card whose dealer is no longer onboarded at Confirm → the writer is told the card is required", async () => {
        isDealerOnboarded.mockResolvedValue(ONBOARDED);
        await run(ISR, "create_quote", { lead_id: "DL-7", lines: LINES, payment_terms: "cash" });
        const plan = APPLIERS.create_quote.schema.parse(stored().plan);
        isDealerOnboarded.mockResolvedValue(NEW_DEALER);
        await APPLIERS.create_quote.apply({ tx: TX, user: ISR, step: 1 }, plan);
        expect(createLeadCommercial).toHaveBeenCalledWith(expect.objectContaining({ requireDealCard: true }), { tx: TX });
    });

    it("a card saved before the deal card → refused with the writer-style sentence, nothing written", async () => {
        const plan = APPLIERS.create_quote.schema.parse({
            lead_id: "DL-7", event_type: "quote_issue", final_price: 1, deal_notes: null,
            product_lines: [{ asset_type: "battery", product_id: "b-105", product_name: "x", model_id: "m", unit_price: 1, quantity: 1 }],
            terms: { dealer_payment_terms: "cash", credit_days: null, customer_finance: null },
        });
        await expect(APPLIERS.create_quote.apply({ tx: TX, user: ISR, step: 1 }, plan)).rejects.toMatchObject({
            status: 409,
            message: expect.stringMatching(/before the deal card/),
        });
        expect(createLeadCommercial).not.toHaveBeenCalled();
    });
});

describe("send_quote", () => {
    it("an approved quote with a PDF → preview naming the quote and the lead's own number; no Edit button", async () => {
        loadLatestQuote.mockResolvedValue(quoteView());
        const r = await run(ISR, "send_quote", { lead_id: "DL-7" });
        expect(r.kind).toBe("preview");
        const s = stored();
        expect(s.plan).toEqual({ lead_id: "DL-7", commercial_id: "com-3", quote_number: "ITQ-2026-0003", channels: ["whatsapp"] });
        const text = previewText(s.preview);
        expect(text).toContain("Quote: ITQ-2026-0003 (v3)");
        expect(text).toContain("WhatsApp: 9876543210");
        expect(text).toContain("Total (incl. GST): ₹99,120");
        const payload = renderTurn({ text: "", results: [{ tool: "send_quote", result: r }] });
        expect(payload.kind === "buttons" && payload.buttons.map((b) => b.title)).toEqual(["Confirm", "Cancel"]);
    });

    it("with an email on the lead, email goes too by default", async () => {
        loadLatestQuote.mockResolvedValue(quoteView());
        loadQuote.mockResolvedValue(sendRow({ dealer_email: "abc@traders.in" }));
        await run(ASM, "send_quote", { lead_id: "DL-7" });
        expect(stored().plan.channels).toEqual(["whatsapp", "email"]);
        expect(previewText(stored().preview)).toContain("Email: abc@traders.in");
    });

    it("pending / rejected / no PDF / no quote / no email → declined with the reason, nothing proposed", async () => {
        loadLatestQuote.mockResolvedValue(quoteView({ approval_status: "pending" }));
        loadQuote.mockResolvedValue(sendRow({ approval_status: "pending", quote_pdf_url: null }));
        expect(await run(ISR, "send_quote", { lead_id: "DL-7" })).toMatchObject({ kind: "declined", reason: expect.stringMatching(/waiting for ceo approval/) });

        loadLatestQuote.mockResolvedValue(quoteView({ approval_status: "rejected", rejection_reason: "margin too thin" }));
        loadQuote.mockResolvedValue(sendRow({ approval_status: "rejected" }));
        expect(await run(ISR, "send_quote", { lead_id: "DL-7" })).toMatchObject({ reason: expect.stringMatching(/rejected by the CEO \(margin too thin\)/) });

        loadLatestQuote.mockResolvedValue(quoteView());
        loadQuote.mockResolvedValue(sendRow({ quote_pdf_url: null }));
        expect(await run(ISR, "send_quote", { lead_id: "DL-7" })).toMatchObject({ reason: expect.stringMatching(/PDF isn't ready/) });

        loadQuote.mockResolvedValue(sendRow());
        expect(await run(ISR, "send_quote", { lead_id: "DL-7", channels: ["email"] })).toMatchObject({ reason: expect.stringMatching(/no valid email/) });

        loadLatestQuote.mockResolvedValue(null);
        expect(await run(ISR, "send_quote", { lead_id: "DL-7" })).toMatchObject({ reason: expect.stringMatching(/no quote yet/) });
        expect(createPending).not.toHaveBeenCalled();
    });

    it("ID 60: a revision still at the CEO replaces nothing — the last approved version is the one sent", async () => {
        const v1 = quoteView({ commercial_id: "com-1", version_no: 1, quote_number: "ITQ-2026-0001" });
        const v2 = quoteView({ commercial_id: "com-2", version_no: 2, approval_status: "pending", quote_number: null, pdf_ready: false });
        loadLatestQuote.mockImplementation(async (_lead: string, pick?: string) => (pick === "live" ? v1 : v2));
        loadQuote.mockResolvedValue(sendRow({ commercial_id: "com-1", version_no: 1, quote_number: "ITQ-2026-0001" }));
        const r = await run(ISR, "send_quote", { lead_id: "DL-7" });
        expect(r.kind).toBe("preview");
        expect(loadQuote).toHaveBeenCalledWith("DL-7", "com-1");
        expect(stored().plan).toMatchObject({ commercial_id: "com-1", quote_number: "ITQ-2026-0001" });
        expect(previewText(stored().preview)).toMatch(/v2 is waiting for ceo approval, so v1 is still the current quote/);
    });

    it("ID 75: the card says the send moves the lead to Awaiting customer decision, and that resets the idle clock", async () => {
        loadLatestQuote.mockResolvedValue(quoteView());
        findLeadInScope.mockResolvedValue(lead({ lead_status: "Commercials_Explained" }));
        await run(ISR, "send_quote", { lead_id: "DL-7" });
        expect(stored().preview.lines).toContainEqual({
            label: "Status once sent",
            value: `${statusLabel("Commercials_Explained")} → ${statusLabel("Awaiting_Customer_Decision")}`,
        });
        expect(stored().preview.resets_idle_clock).toBe(true);
        findLeadInScope.mockResolvedValue(lead({ lead_status: "Commercials_Finalised" }));
        await run(ISR, "send_quote", { lead_id: "DL-7" });
        expect(stored().preview.lines).toContainEqual({ label: "Status once sent", value: "no change" });
        expect(stored().preview.resets_idle_clock).toBe(false);
    });

    it("a send where nothing went is a failed send for the executor (a repeat tap must not say Already saved)", () => {
        const failed = APPLIERS.send_quote.sendFailed!;
        expect(failed({ sent: [], failed: ["whatsapp"], error: "x" })).toBe(true);
        expect(failed(null)).toBe(true);
        expect(failed({ sent: ["whatsapp"], failed: ["email"] })).toBe(false);
        expect(APPLIERS.invite_dealer_onboarding.sendFailed!({ delivered: false })).toBe(true);
        expect(APPLIERS.invite_dealer_onboarding.sendFailed!({ delivered: true })).toBe(false);
        expect(renderTapOutcome({ kind: "send_failed" }).body).toMatch(/didn't go through[\s\S]*Ask me again for a new card/);
    });

    it("the applier writes nothing in the tx; afterCommit sends and reports per channel", async () => {
        const plan = APPLIERS.send_quote.schema.parse({ lead_id: "DL-7", commercial_id: "com-3", quote_number: "ITQ-2026-0003", channels: ["whatsapp", "email"] });
        sendApprovedQuotation.mockResolvedValue({
            quote_number: "ITQ-2026-0003",
            outcomes: [{ channel: "whatsapp", status: "sent", recipient: "919876543210" }, { channel: "email", status: "failed", recipient: "x@y.in" }],
            sent_count: 1,
            failed_count: 1,
        });
        const out = await APPLIERS.send_quote.apply({ tx: TX, user: ASM, step: 1 }, plan);
        expect(sendApprovedQuotation).not.toHaveBeenCalled();
        expect(await out.afterCommit!()).toEqual({ quote_number: "ITQ-2026-0003", sent: ["whatsapp"], failed: ["email"], error: null });
        expect(sendApprovedQuotation).toHaveBeenCalledWith({
            leadId: "DL-7", commercialId: "com-3", channels: ["whatsapp", "email"], actor: { id: "asm-1", name: "Rahul" },
        });

        // The gate closed between preview and Confirm: nothing went, and it says why.
        sendApprovedQuotation.mockRejectedValue(new QuotationNotSendableError("not_approved", "This quotation is pending and cannot be sent to a dealer."));
        expect(await out.afterCommit!()).toMatchObject({ sent: [], failed: ["whatsapp", "email"], error: expect.stringMatching(/pending/) });
    });
});

describe("withdraw_quote (ID 78)", () => {
    it("the latest quote + a reason → a preview naming the quote, the reason and the consequence", async () => {
        loadLatestQuote.mockResolvedValue(quoteView());
        const r = await run(ISR, "withdraw_quote", { lead_id: "DL-7", reason: "OEM price went up" });
        expect(r.kind).toBe("preview");
        const s = stored();
        expect(s.tool).toBe("withdraw_quote");
        expect(s.plan).toEqual({
            lead_id: "DL-7", commercial_id: "com-3", quote_number: "ITQ-2026-0003", version_no: 3, reason: "OEM price went up",
        });
        const text = previewText(s.preview);
        expect(text).toMatch(/ITQ-2026-0003 \(v3\)/);
        expect(text).toMatch(/OEM price went up/);
        expect(text).toMatch(/can no longer answer/);
    });

    it("the card's Status line and idle clock are the writer's (leadMoveOnWithdraw on the quotes left in play)", async () => {
        loadLatestQuote.mockResolvedValue(quoteView());
        // Commercials stage, nothing else in play → back to Under discussion, a real status change.
        findLeadInScope.mockResolvedValue(lead({ lead_status: "Awaiting_Customer_Decision" }));
        await run(ISR, "withdraw_quote", { lead_id: "DL-7", reason: "OEM price went up" });
        expect(stored().preview.lines).toContainEqual({
            label: "Status",
            value: `${statusLabel("Awaiting_Customer_Decision")} → ${statusLabel("Under_Discussion")}`,
        });
        expect(stored().preview.resets_idle_clock).toBe(true);
        // Another approved version stays live → nothing moves; a plain note is not work.
        dbRows.push({ version_no: 3, quote_number: "ITQ-2026-0003", approval_status: "approved" });
        dbRows.push({ version_no: 2, quote_number: "ITQ-2026-0002", approval_status: "approved" });
        await run(ISR, "withdraw_quote", { lead_id: "DL-7", reason: "OEM price went up" });
        expect(stored().preview.lines).toContainEqual({ label: "Status", value: "no change — v2 is still live" });
        expect(stored().preview.resets_idle_clock).toBe(false);
        // Under discussion already → no move.
        dbRows.length = 0;
        findLeadInScope.mockResolvedValue(lead());
        await run(ISR, "withdraw_quote", { lead_id: "DL-7", reason: "OEM price went up" });
        expect(stored().preview.lines).toContainEqual({ label: "Status", value: "no change" });
        expect(stored().preview.resets_idle_clock).toBe(false);
    });

    it("a quote still waiting for the CEO can be withdrawn", async () => {
        loadLatestQuote.mockResolvedValue(quoteView({ approval_status: "pending", quote_number: null, pdf_ready: false }));
        const r = await run(ASM, "withdraw_quote", { lead_id: "DL-7", reason: "wrong quantity" });
        expect(r.kind).toBe("preview");
        expect(previewText(stored().preview)).toMatch(/Waiting for CEO approval/);
    });

    it("a rejected revision above a live quote: the live quote is the one withdrawn", async () => {
        const v1 = quoteView({ commercial_id: "com-1", version_no: 1, quote_number: "ITQ-2026-0001" });
        const v2 = quoteView({ commercial_id: "com-2", version_no: 2, approval_status: "rejected" });
        loadLatestQuote.mockImplementation(async (_lead: string, pick?: string) => (pick === "in_play" ? v1 : v2));
        const r = await run(ISR, "withdraw_quote", { lead_id: "DL-7", reason: "dealer went quiet" });
        expect(r.kind).toBe("preview");
        expect(stored().plan).toMatchObject({ commercial_id: "com-1", version_no: 1 });
    });

    it("no reason, or one too short → a question, nothing proposed", async () => {
        loadLatestQuote.mockResolvedValue(quoteView());
        expect((await run(ISR, "withdraw_quote", { lead_id: "DL-7" })).kind).toBe("question");
        expect((await run(ISR, "withdraw_quote", { lead_id: "DL-7", reason: " no " })).kind).toBe("question");
        expect(createPending).not.toHaveBeenCalled();
    });

    it("no quote / rejected / dealer approved / closed lead → declined, nothing proposed", async () => {
        loadLatestQuote.mockResolvedValue(null);
        expect(await run(ISR, "withdraw_quote", { lead_id: "DL-7", reason: "price changed" })).toMatchObject({ kind: "declined", reason: expect.stringMatching(/no open quote/) });

        loadLatestQuote.mockResolvedValue(quoteView({ approval_status: "rejected" }));
        expect(await run(ISR, "withdraw_quote", { lead_id: "DL-7", reason: "price changed" })).toMatchObject({ reason: expect.stringMatching(/rejected by the CEO/) });

        // After the dealer's yes only Mark Won / Mark Lost close the lead.
        loadLatestQuote.mockResolvedValue(quoteView({ dealer_decision: "approved" }));
        expect(await run(ISR, "withdraw_quote", { lead_id: "DL-7", reason: "price changed" })).toMatchObject({ reason: expect.stringMatching(/Mark the lead Won or Lost/) });

        loadLatestQuote.mockResolvedValue(quoteView());
        findLeadInScope.mockResolvedValue(lead({ lead_status: "Won" }));
        expect(await run(ISR, "withdraw_quote", { lead_id: "DL-7", reason: "price changed" })).toMatchObject({ reason: expect.stringMatching(/lead is Won/) });
        expect(createPending).not.toHaveBeenCalled();
    });

    it("not owned / pilot off → no pending action", async () => {
        loadLatestQuote.mockResolvedValue(quoteView());
        findLeadInScope.mockResolvedValue(lead({ current_owner_id: "isr-2", owned: false }));
        expect((await run(ISR, "withdraw_quote", { lead_id: "DL-7", reason: "price changed" })).kind).toBe("declined");
        const t = tool(ISR, "withdraw_quote");
        const off = await t.run({ ...ctx(ISR), writesEnabled: false }, t.schema.parse({ lead_id: "DL-7", reason: "price changed" }));
        expect(off.kind).toBe("declined");
        expect(createPending).not.toHaveBeenCalled();
    });

    it("the applier withdraws through the shared writer on the executor's tx", async () => {
        withdrawWriter.mockResolvedValue({ quoteNumber: "ITQ-2026-0003", leadStatus: "Under_Discussion", liveQuote: null });
        const plan = APPLIERS.withdraw_quote.schema.parse({
            lead_id: "DL-7", commercial_id: "com-3", quote_number: "ITQ-2026-0003", version_no: 3, reason: "OEM price went up",
        });
        const out = await APPLIERS.withdraw_quote.apply({ tx: TX, user: ISR, step: 1 }, plan);
        expect(withdrawWriter).toHaveBeenCalledWith(
            { leadId: "DL-7", commercialId: "com-3", actorId: "isr-1", reason: "OEM price went up" },
            { tx: TX },
        );
        expect(out).toEqual({ quote_number: "ITQ-2026-0003", lead_status: "Under_Discussion", live_quote_version: null });
        expect(APPLIERS.withdraw_quote.needsSecondConfirm(plan)).toBe(false);
    });

    it("the reply says what happened to the lead", () => {
        const confirmed = (after: Record<string, unknown>): ExecOutcome => ({
            kind: "confirmed", actionId: "act-1", tool: "withdraw_quote", leadId: "DL-7",
            title: "Withdraw quote — ABC Traders", after, crmUrl: "https://crm/l/DL-7", extra: null,
        });
        const back = renderTapOutcome(confirmed({ quote_number: "ITQ-2026-0003", lead_status: "Under_Discussion", live_quote_version: null }));
        expect(back).toMatchObject({ kind: "text", body: expect.stringMatching(/ITQ-2026-0003 withdrawn[\s\S]*back to Under discussion/) });
        const stay = renderTapOutcome(confirmed({ quote_number: "ITQ-2026-0003", lead_status: "Awaiting_Customer_Decision", live_quote_version: 2 }));
        expect(stay).toMatchObject({ kind: "text", body: expect.stringMatching(/v2 is still live[\s\S]*status is unchanged/) });
    });
});

describe("quote_status", () => {
    it("out of scope ≡ not found", async () => {
        findLeadInScope.mockResolvedValue(null);
        expect(await run(ISR, "quote_status", { lead_id: "DL-X" })).toEqual({ kind: "not_found" });
    });

    it("a lead's latest quote: approval, lines, terms, last send — readable when not owned", async () => {
        findLeadInScope.mockResolvedValue(lead({ owned: false, current_owner_id: "isr-2" }));
        loadLatestQuote.mockImplementation(async (_id: string, pick?: string) =>
            pick === "live" ? null : quoteView({ approval_status: "rejected", approval_mode: "manual", rejection_reason: "too low" }),
        );
        dbRows.push({ channel: "whatsapp", status: "sent", created_at: "2026-09-21T10:00:00Z", sent_by_name: "Priya" });
        const r = await run(ASM, "quote_status", { lead_id: "DL-7" });
        expect(r).toMatchObject({
            kind: "quote",
            quote: {
                has_quote: true, version: 3, approval: "Rejected by CEO", rejection_reason: "too low", owned_by_you: false,
                can_send: false, live_version: null, product_lines: [{ product_id: "b-105", quantity: 2, unit_price: 42000 }],
                // Timestamps reach the model in IST.
                last_sent: { channel: "whatsapp", status: "sent", by: "Priya", at: "2026-09-21T15:30:00+05:30" },
                created_at: "2026-09-20T15:30:00+05:30",
            },
        });
        expect(JSON.stringify(r)).not.toMatch(/oem/);
    });

    it("ID 60: a revision at the CEO leaves the last approved version live — can_send follows the LIVE version", async () => {
        loadLatestQuote.mockImplementation(async (_id: string, pick?: string) =>
            pick === "live"
                ? quoteView({ commercial_id: "com-2", version_no: 2, quote_number: "ITQ-2026-0002" })
                : quoteView({ commercial_id: "com-3", version_no: 3, approval_status: "pending", approval_mode: "manual", pdf_ready: false }),
        );
        const r = await run(ISR, "quote_status", { lead_id: "DL-7" });
        expect(r).toMatchObject({
            kind: "quote",
            quote: {
                version: 3, approval: "Waiting for CEO approval", can_send: true,
                live_version: { version: 2, quote_number: "ITQ-2026-0002", pdf_ready: true, is_latest: false },
            },
        });
        loadLatestQuote.mockImplementation(async (_id: string, pick?: string) =>
            quoteView(pick === "live" ? { pdf_ready: false } : { pdf_ready: false }),
        );
        expect(await run(ISR, "quote_status", { lead_id: "DL-7" })).toMatchObject({
            quote: { can_send: false, live_version: { version: 3, is_latest: true, pdf_ready: false } },
        });
    });

    it("no lead → the user's own pending / rejected quotes as a list, with phone and owner", async () => {
        dbRows.push({
            id: "DL-7", shop_name: "ABC Traders", phone: "9876543210", current_owner_id: "isr-1", current_owner_name: "Priya",
            lead_status: "Under_Discussion", approval_status: "pending", total: "1",
        });
        const r = await run(ISR, "quote_status", {});
        expect(r).toMatchObject({
            kind: "leads", total: 1,
            rows: [{
                id: "DL-7", status: "Waiting for CEO approval", status_label: "Waiting for CEO approval", owned_by_you: true,
                phone: "9876543210", owner_name: "Priya",
            }],
        });
        // The list is scoped like the reads (own tabs / own open leads), not a bare owner filter.
        const sqlText = execute.mock.calls
            .map((c) => new PgDialect().sqlToQuery(c[0] as SQL).sql)
            .find((x) => x.includes("dealer_lead_commercials"))!;
        expect(sqlText).toMatch(/is_active IS NOT FALSE/);
    });
});

describe("render", () => {
    const confirmed = (tool: "create_quote" | "send_quote", after: Record<string, unknown>, extra: Record<string, unknown> | null): ExecOutcome => ({
        kind: "confirmed", actionId: "act-1", tool, leadId: "DL-7", title: "Quote — ABC Traders", after, crmUrl: "https://crm/l/DL-7", extra,
    });
    const body = (o: ExecOutcome) => {
        const p = renderTapOutcome(o);
        return p.kind === "text" ? p.body : "";
    };

    it("create_quote: auto-approved with its PDF, or waiting for the CEO", () => {
        expect(body(confirmed("create_quote", { quote_version: 4, auto_approved: true }, { quote_number: "ITQ-2026-0007" }))).toBe(
            '✅ Quote v4 saved and auto-approved. PDF ITQ-2026-0007 is ready — say "send quote" to send it to the dealer.\nhttps://crm/l/DL-7',
        );
        expect(body(confirmed("create_quote", { quote_version: 4, auto_approved: true }, { quote_number: null }))).toMatch(/PDF could not be made/);
        expect(body(confirmed("create_quote", { quote_version: 5, auto_approved: false }, { quote_number: null }))).toMatch(/^⏳ Quote v5 saved — waiting for CEO approval/);
    });

    it("send_quote: never says sent for a channel that failed", () => {
        expect(body(confirmed("send_quote", {}, { quote_number: "ITQ-1", sent: ["whatsapp"], failed: [], error: null }))).toMatch(/^✅ Quotation ITQ-1 sent to the dealer on WhatsApp\./);
        expect(body(confirmed("send_quote", {}, { quote_number: "ITQ-1", sent: ["whatsapp"], failed: ["email"], error: null }))).toMatch(/but email failed/);
        expect(body(confirmed("send_quote", {}, { quote_number: "ITQ-1", sent: [], failed: ["whatsapp"], error: "boom" }))).toMatch(/^⚠️ The quotation was not sent \(boom\)/);
        expect(body(confirmed("send_quote", {}, null))).toMatch(/could not be confirmed/);
    });
});
