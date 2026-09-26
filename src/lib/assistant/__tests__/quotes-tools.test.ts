import { beforeEach, describe, expect, it, vi } from "vitest";

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
const afterCommit = vi.fn(async () => ({ quote_number: "ITQ-2026-0007" }));
const createLeadCommercial = vi.fn();
vi.mock("@/lib/leads/createCommercial", () => ({ createLeadCommercial }));

const { toolsFor, toolNamesFor } = await import("../registry");
const { APPLIERS } = await import("../appliers");
const { QuotationNotSendableError } = await import("@/lib/leads/quoteSendGate");
const { quoteTotal } = await import("../tools/write/createQuote");
const { renderTapOutcome, renderTurn } = await import("@/lib/wa-assistant/render");
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
    createLeadCommercial.mockResolvedValue({
        commercialId: "com-4", versionNo: 4, approvalStatus: "approved", autoApproved: true, evaluation: null, afterCommit,
    });
});

describe("registry", () => {
    it("both roles get all four quote tools; off the pilot list only the two reads", () => {
        for (const u of [ISR, ASM]) {
            const names = toolNamesFor(u.role, true);
            for (const n of ["product_catalogue", "quote_status", "create_quote", "send_quote"]) expect(names, `${u.role} ${n}`).toContain(n);
            const readOnly = toolNamesFor(u.role, false);
            expect(readOnly).toContain("product_catalogue");
            expect(readOnly).toContain("quote_status");
            expect(readOnly).not.toContain("create_quote");
            expect(readOnly).not.toContain("send_quote");
        }
        expect(APPLIERS.create_quote).toBeDefined();
        expect(APPLIERS.send_quote).toBeDefined();
    });
});

describe("product_catalogue", () => {
    it("matches every word across name / model / spec, and never carries a price", async () => {
        const r = await run(ISR, "product_catalogue", { query: "51.2v 105ah" });
        expect(r).toEqual({
            kind: "products",
            total: 1,
            rows: [{ product_id: "b-105", asset_type: "battery", product_name: "LFP 51.2V 105Ah", model_id: "ITB-51105", detail: "51.2V · 105Ah · LFP" }],
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
    });
});

describe("create_quote", () => {
    const LINES = [{ product_id: "b-105", quantity: 2, unit_price: 42000 }];

    it("first quote, every line at or above reference → quote_issue, auto-approve forecast, no floor price shown", async () => {
        const r = await run(ISR, "create_quote", { lead_id: "DL-7", lines: LINES, credit_terms: "30 days", payment_method: "cash" });
        expect(r).toMatchObject({ kind: "preview", action_id: "act-1" });
        const s = stored();
        expect(s.tool).toBe("create_quote");
        expect(s.plan).toMatchObject({
            lead_id: "DL-7",
            event_type: "quote_issue",
            final_price: 84000,
            credit_terms: "30 days",
            payment_method: "cash",
            // Name, model and asset type are the catalogue's, not the model's.
            product_lines: [{ asset_type: "battery", product_id: "b-105", product_name: "LFP 51.2V 105Ah", model_id: "ITB-51105", unit_price: 42000, quantity: 2 }],
        });
        const text = previewText(s.preview);
        expect(s.preview.title).toBe("Quote — ABC Traders");
        expect(text).toContain("2 × LFP 51.2V 105Ah @ ₹42,000 = ₹84,000");
        expect(text).toContain("Total (before GST): ₹84,000");
        expect(text).toMatch(/Auto-approved on Confirm/);
        expect(s.preview.warning).toBeNull();
        expect(s.preview.resets_idle_clock).toBe(false);
        expect(text).not.toMatch(/41,000|41000/);
        // Judged at the turn's clock, against the resolved lines.
        expect(loadLiveOemPrices).toHaveBeenCalledWith(s.plan.product_lines, undefined, NOW);
    });

    it("a line below reference → CEO warning, still without the reference figure", async () => {
        await run(ASM, "create_quote", { lead_id: "DL-7", lines: [{ product_id: "b-105", quantity: 1, unit_price: 39000 }] });
        const { preview } = stored();
        expect(previewText(preview)).toMatch(/Goes to the CEO for approval/);
        expect(preview.warning).toMatch(/Needs CEO approval: 1 line is below the reference price/);
        expect(previewText(preview)).not.toMatch(/41,000|41000|2,000/);
    });

    it("a product with no reference price also goes to the CEO", async () => {
        await run(ISR, "create_quote", { lead_id: "DL-7", lines: [{ product_id: "b-80", quantity: 1, unit_price: 99999 }] });
        expect(stored().preview.warning).toMatch(/Needs CEO approval/);
    });

    it("an existing quote → quote_revision, titled and naming what it replaces", async () => {
        loadLatestQuote.mockResolvedValue(quoteView({ approval_status: "pending" }));
        await run(ISR, "create_quote", { lead_id: "DL-7", lines: LINES });
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
        await run(ISR, "create_quote", { lead_id: "DL-7", lines: LINES, warranty_terms: "36 months" });
        const plan = APPLIERS.create_quote.schema.parse(stored().plan);
        const out = await APPLIERS.create_quote.apply({ tx: TX, user: ISR, step: 1 }, plan);
        expect(createLeadCommercial).toHaveBeenCalledWith(
            {
                leadId: "DL-7",
                actor: { id: "isr-1", name: "Priya" },
                body: expect.objectContaining({ event_type: "quote_issue", final_price: 84000, warranty_terms: "36 months" }),
            },
            { tx: TX },
        );
        expect(out).toMatchObject({ commercial_id: "com-4", quote_version: 4, approval_status: "approved", auto_approved: true });
        expect(afterCommit).not.toHaveBeenCalled();
        expect(await out.afterCommit!()).toEqual({ quote_number: "ITQ-2026-0007" });
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

describe("quote_status", () => {
    it("out of scope ≡ not found", async () => {
        findLeadInScope.mockResolvedValue(null);
        expect(await run(ISR, "quote_status", { lead_id: "DL-X" })).toEqual({ kind: "not_found" });
    });

    it("a lead's latest quote: approval, lines, terms, last send — readable when not owned", async () => {
        findLeadInScope.mockResolvedValue(lead({ owned: false, current_owner_id: "isr-2" }));
        loadLatestQuote.mockResolvedValue(quoteView({ approval_status: "rejected", approval_mode: "manual", rejection_reason: "too low" }));
        dbRows.push({ channel: "whatsapp", status: "sent", created_at: "2026-09-21T10:00:00Z", sent_by_name: "Priya" });
        const r = await run(ASM, "quote_status", { lead_id: "DL-7" });
        expect(r).toMatchObject({
            kind: "quote",
            quote: {
                has_quote: true, version: 3, approval: "Rejected by CEO", rejection_reason: "too low", owned_by_you: false,
                can_send: false, product_lines: [{ product_id: "b-105", quantity: 2, unit_price: 42000 }],
                last_sent: { channel: "whatsapp", status: "sent", by: "Priya" },
            },
        });
        expect(JSON.stringify(r)).not.toMatch(/oem/);
    });

    it("no lead → the user's own pending / rejected quotes as a list", async () => {
        dbRows.push({ id: "DL-7", shop_name: "ABC Traders", current_owner_id: "isr-1", approval_status: "pending", total: "1" });
        const r = await run(ISR, "quote_status", {});
        expect(r).toMatchObject({ kind: "leads", total: 1, rows: [{ id: "DL-7", status: "Waiting for CEO approval", owned_by_you: true }] });
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
