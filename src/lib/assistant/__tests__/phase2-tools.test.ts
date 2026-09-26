import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 2 lead actions: transfer_to_asm, reassign_lead, escalate_lead,
// mark_converted, invite_dealer_onboarding, create_lead. Every CRM writer and
// lookup is mocked — these tests pin what each tool PROPOSES and refuses, and
// that each applier calls the shared service on the executor's tx.

const colleagues: Record<string, unknown>[] = [];
const execute = vi.fn(async (_q?: unknown) => colleagues);
vi.mock("@/lib/db", () => ({ db: { execute } }));
const findLeadInScope = vi.fn();
vi.mock("../scope", async (orig) => ({ ...(await orig<typeof import("../scope")>()), findLeadInScope }));
const createPending = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ id: "act-1", expiresAt: new Date() }));
vi.mock("../actions", async (orig) => ({ ...(await orig<typeof import("../actions")>()), createPending }));

const listAsmOptions = vi.fn();
vi.mock("@/lib/inside-sales/asmOptions", () => ({ listAsmOptions }));
const transferLeadToAsm = vi.fn(async () => {});
vi.mock("@/lib/leads/transferToAsm", async (orig) => ({ ...(await orig<typeof import("@/lib/leads/transferToAsm")>()), transferLeadToAsm }));
const reassignLead = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});
vi.mock("@/lib/leads/reassign", async (orig) => ({ ...(await orig<typeof import("@/lib/leads/reassign")>()), reassignLead }));
const notify = vi.fn(async () => {});
const escalateLead = vi.fn(async () => ({ escalationId: "esc-1", notify }));
vi.mock("@/lib/leads/escalate", async (orig) => ({ ...(await orig<typeof import("@/lib/leads/escalate")>()), escalateLead }));
const markLeadConverted = vi.fn(async () => ({ applicationId: "app-1", notify }));
vi.mock("@/lib/leads/markConverted", async (orig) => ({ ...(await orig<typeof import("@/lib/leads/markConverted")>()), markLeadConverted }));
const prepareOnboardingInvite = vi.fn();
const sendOnboardingInvite = vi.fn();
vi.mock("@/lib/leads/onboardingInvite", () => ({ prepareOnboardingInvite, sendOnboardingInvite }));
const findLeadIdByPhone = vi.fn<(...a: unknown[]) => Promise<string | null>>(async () => null);
const createInsideSalesLead = vi.fn<(...a: unknown[]) => Promise<unknown>>();
vi.mock("@/lib/inside-sales/createLead", async (orig) => ({
    ...(await orig<typeof import("@/lib/inside-sales/createLead")>()),
    findLeadIdByPhone,
    createInsideSalesLead,
}));

const { toolsFor } = await import("../registry");
const { APPLIERS } = await import("../appliers");
const { ActionRejected } = await import("../applierSpec");
const { ReassignError } = await import("@/lib/leads/reassign");
const { DuplicatePhoneError } = await import("@/lib/inside-sales/createLead");
const { matchPeople } = await import("../tools/write/people");
const { tenDigitPhone } = await import("../tools/write/createLead");
const { renderTapOutcome } = await import("@/lib/wa-assistant/render");
import type { AssistantUser, Preview, ToolContext } from "../types";

const ISR: AssistantUser = { id: "isr-1", name: "Priya", role: "inside_sales_rep" };
const ASM: AssistantUser = { id: "asm-1", name: "Rahul", role: "asm" };
const NOW = new Date("2026-09-24T12:00:00Z"); // Thu 24 Sep 2026, 17:30 IST
const TX = { tx: true } as never;
const ctx = (user: AssistantUser): ToolContext => ({ user, messageId: null, now: NOW, writesEnabled: true });
const lead = (over: Record<string, unknown> = {}) => ({
    id: "DL-7", shop_name: "ABC Traders", dealer_name: "Ramesh", phone: "9876543210", city: "Pune", state: "Maharashtra",
    current_owner_id: "isr-1", asm_id: null, lead_status: "Under_Discussion", interest_level: "warm",
    next_follow_up_at: null, updated_at: new Date("2026-09-24T10:00:00Z"), owned: true, ...over,
});
const tool = (user: AssistantUser, name: string) => toolsFor(user.role, true).find((t) => t.name === name);
const run = async (user: AssistantUser, name: string, input: Record<string, unknown>) => {
    const t = tool(user, name)!;
    return t.run(ctx(user), t.schema.parse(input));
};
const stored = () =>
    createPending.mock.calls.at(-1)![0] as { plan: Record<string, unknown>; preview: Preview; tool: string; leadId: string | null };
const ASMS = [
    { user_id: "asm-1", name: "Rahul Sharma", email: "r@x", in_territory: true },
    { user_id: "asm-2", name: "Rahul Verma", email: "rv@x", in_territory: false },
    { user_id: "asm-3", name: "Kiran Patil", email: "k@x", in_territory: false },
];

beforeEach(() => {
    vi.clearAllMocks();
    colleagues.length = 0;
    findLeadInScope.mockResolvedValue(lead());
    listAsmOptions.mockResolvedValue({ asms: ASMS, total_asms: 3 });
});

describe("registry", () => {
    it("transfer_to_asm is ISR-only; the rest are both roles", () => {
        expect(tool(ISR, "transfer_to_asm")).toBeDefined();
        expect(tool(ASM, "transfer_to_asm")).toBeUndefined();
        for (const n of ["reassign_lead", "escalate_lead", "mark_converted", "invite_dealer_onboarding", "create_lead"]) {
            expect(tool(ISR, n), n).toBeDefined();
            expect(tool(ASM, n), n).toBeDefined();
        }
    });
});

describe("matchPeople", () => {
    const P = [{ id: "a", name: "Rahul Sharma" }, { id: "b", name: "Rahul Verma" }, { id: "c", name: "Kiran Patil" }];
    it("id, then full name, then word prefixes — never a guess", () => {
        expect(matchPeople(P, "b").map((p) => p.id)).toEqual(["b"]);
        expect(matchPeople(P, "rahul  SHARMA").map((p) => p.id)).toEqual(["a"]);
        expect(matchPeople(P, "rah ver").map((p) => p.id)).toEqual(["b"]);
        expect(matchPeople(P, "Rahul").map((p) => p.id)).toEqual(["a", "b"]);
        expect(matchPeople(P, "Suresh")).toEqual([]);
    });
});

describe("transfer_to_asm", () => {
    const base = { lead_id: "DL-7", reason: "Site_Visit_Needed", visit_type: "Initial_Visit" };

    it("an out-of-territory ASM with a reason → preview with the new owner, the status change and the read-only warning", async () => {
        const r = await run(ISR, "transfer_to_asm", { ...base, asm: "Kiran", out_of_territory_reason: "dealer asked for Kiran" });
        expect(r.kind).toBe("preview");
        const a = stored();
        expect(a.tool).toBe("transfer_to_asm");
        expect(a.plan).toMatchObject({ asm_id: "asm-3", out_of_territory_reason: "dealer asked for Kiran", suggested_visit_date: null });
        expect(a.preview.title).toBe("Transfer ABC Traders → Kiran Patil");
        expect(a.preview.warning).toMatch(/read-only for you/);
        expect(a.preview.lines).toContainEqual({ label: "Status", value: "Under Discussion → Transferred to ASM" });
        expect(listAsmOptions).toHaveBeenCalledWith({ state: "Maharashtra", city: "Pune", includeOutOfTerritory: true });
    });

    it("two matching ASMs → asks which, never picks", async () => {
        const r = await run(ISR, "transfer_to_asm", { ...base, asm: "Rahul" });
        expect(r).toEqual({ kind: "question", question: "Which ASM do you mean: Rahul Sharma, Rahul Verma?" });
        expect(createPending).not.toHaveBeenCalled();
    });

    it("no match → asks, naming the in-territory ASMs", async () => {
        const r = await run(ISR, "transfer_to_asm", { ...base, asm: "Suresh" });
        expect(r.kind).toBe("question");
        expect((r as { question: string }).question).toMatch(/Rahul Sharma/);
        expect((r as { question: string }).question).not.toMatch(/Kiran/);
    });

    it("an out-of-territory ASM without a reason → asks why", async () => {
        const r = await run(ISR, "transfer_to_asm", { ...base, asm: "Kiran Patil" });
        expect(r).toEqual({ kind: "question", question: "Kiran Patil doesn't cover Pune, Maharashtra. Why transfer to them? I need a short reason." });
    });

    it("a past visit date → asks again", async () => {
        const r = await run(ISR, "transfer_to_asm", { ...base, asm: "Rahul Sharma", suggested_visit_date: "2026-09-01" });
        expect(r.kind).toBe("question");
    });

    it("applier: transferLeadToAsm on the executor's tx, acting as the user", async () => {
        const plan = {
            lead_id: "DL-7", asm_id: "asm-1", asm_name: "Rahul Sharma", reason: "Site_Visit_Needed", visit_type: "Demo",
            suggested_visit_date: "2026-09-26", dealer_preferred_time: null, handoff_notes: "", pending_items: [], out_of_territory_reason: null,
        };
        await APPLIERS.transfer_to_asm.apply({ tx: TX, user: ISR, step: 1 }, APPLIERS.transfer_to_asm.schema.parse(plan));
        expect(transferLeadToAsm).toHaveBeenCalledWith(
            expect.objectContaining({ leadId: "DL-7", actorId: "isr-1", asmId: "asm-1", visitType: "Demo", suggestedVisitDate: "2026-09-26" }),
            { tx: TX },
        );
    });
});

describe("reassign_lead", () => {
    beforeEach(() => {
        colleagues.push({ id: "isr-2", name: "Neha Joshi", role: "inside_sales_rep" }, { id: "asm-9", name: "Neha Kulkarni", role: "asm" });
    });

    it("only active ISRs and ASMs, never the user themself", async () => {
        await run(ASM, "reassign_lead", { lead_id: "DL-7", to: "Neha Joshi", reason: "dealer prefers phone follow-up now" });
        const { PgDialect } = await import("drizzle-orm/pg-core");
        const q = new PgDialect().sqlToQuery(execute.mock.calls[0]![0] as never);
        expect(q.sql).toMatch(/LOWER\(role\) IN \('inside_sales_rep', 'asm'\)/);
        expect(q.sql).toMatch(/is_active = TRUE/);
        expect(q.params).toContain("asm-1");
    });

    it("a clear match → preview 'you → Name (ISR)' with the read-only warning", async () => {
        const r = await run(ASM, "reassign_lead", { lead_id: "DL-7", to: "Neha Joshi", reason: "dealer prefers phone follow-up now" });
        expect(r.kind).toBe("preview");
        expect(stored().plan).toMatchObject({ target_user_id: "isr-2", reason: "dealer prefers phone follow-up now" });
        expect(stored().preview.lines[0]).toEqual({ label: "Owner", value: "you → Neha Joshi (ISR)" });
    });

    it("ambiguous → asks; a short reason → asks for more, never pads", async () => {
        expect((await run(ASM, "reassign_lead", { lead_id: "DL-7", to: "Neha", reason: "x".repeat(25) })).kind).toBe("question");
        const r = await run(ASM, "reassign_lead", { lead_id: "DL-7", to: "Neha Joshi", reason: "back to IS" });
        expect(r.kind).toBe("question");
        expect(createPending).not.toHaveBeenCalled();
    });

    it("applier: a target deactivated after the preview → target_unavailable", async () => {
        reassignLead.mockRejectedValueOnce(new ReassignError("target_inactive", "Target user is inactive.", 400));
        const plan = APPLIERS.reassign_lead.schema.parse({
            lead_id: "DL-7", target_user_id: "isr-2", target_name: "Neha", target_role: "inside_sales_rep", reason: "x".repeat(20),
        });
        await expect(APPLIERS.reassign_lead.apply({ tx: TX, user: ASM, step: 1 }, plan)).rejects.toEqual(new ActionRejected("target_unavailable"));
    });
});

describe("escalate_lead", () => {
    const notes = "dealer wants a price only the sales head can approve";

    it("reasons are the role's own list", () => {
        expect(tool(ISR, "escalate_lead")!.schema.safeParse({ lead_id: "DL-7", reason: "Dealer_Stalling", urgency: "high", notes }).success).toBe(false);
        expect(tool(ASM, "escalate_lead")!.schema.safeParse({ lead_id: "DL-7", reason: "Dealer_Stalling", urgency: "high", notes }).success).toBe(true);
    });

    it("preview names who is notified (CEO only when urgent)", async () => {
        await run(ISR, "escalate_lead", { lead_id: "DL-7", reason: "Commercial_Decision_Needed", urgency: "urgent", notes });
        expect(stored().preview.lines).toContainEqual({ label: "Notifies", value: "admin, sales head, partner and CEO" });
    });

    it("short notes → asks; a closed lead → declined", async () => {
        expect((await run(ISR, "escalate_lead", { lead_id: "DL-7", reason: "Other", urgency: "normal", notes: "call him" })).kind).toBe("question");
        findLeadInScope.mockResolvedValue(lead({ lead_status: "Lost" }));
        expect((await run(ISR, "escalate_lead", { lead_id: "DL-7", reason: "Other", urgency: "normal", notes })).kind).toBe("declined");
    });

    it("applier: notifications are handed back to run after commit, not sent inside the tx", async () => {
        const plan = APPLIERS.escalate_lead.schema.parse({ lead_id: "DL-7", reason: "Other", notes, urgency: "normal", suggested_action: null });
        const out = await APPLIERS.escalate_lead.apply({ tx: TX, user: ISR, step: 1 }, plan);
        expect(escalateLead).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "isr-1", name: "Priya" } }), { tx: TX });
        expect(notify).not.toHaveBeenCalled();
        expect(out).toMatchObject({ escalation_id: "esc-1", afterCommit: notify });
    });
});

describe("mark_converted", () => {
    it("a valid GSTIN (normalised) → preview; creates the onboarding application", async () => {
        const r = await run(ISR, "mark_converted", { lead_id: "DL-7", gstin: " 27aaacb1234c1z5 " });
        expect(r.kind).toBe("preview");
        expect(stored().plan).toEqual({ lead_id: "DL-7", gstin: "27AAACB1234C1Z5", notes: null });
        expect(stored().preview.lines).toContainEqual({ label: "Status", value: "Under Discussion → Converted" });
        expect(stored().preview.warning).toMatch(/CRM screen/);
    });

    it("a bad GSTIN → asks, never guesses; already Converted → declined", async () => {
        expect((await run(ISR, "mark_converted", { lead_id: "DL-7", gstin: "27AAACB" })).kind).toBe("question");
        findLeadInScope.mockResolvedValue(lead({ lead_status: "Converted" }));
        expect((await run(ISR, "mark_converted", { lead_id: "DL-7", gstin: "27AAACB1234C1Z5" })).kind).toBe("declined");
        expect(createPending).not.toHaveBeenCalled();
    });

    it("applier: markLeadConverted on the tx with the user's role; notify after commit", async () => {
        const plan = APPLIERS.mark_converted.schema.parse({ lead_id: "DL-7", gstin: "27AAACB1234C1Z5", notes: null });
        const out = await APPLIERS.mark_converted.apply({ tx: TX, user: ASM, step: 1 }, plan);
        expect(markLeadConverted).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "asm-1", name: "Rahul", role: "asm" } }), { tx: TX });
        expect(out).toMatchObject({ onboarding_application_id: "app-1", afterCommit: notify });
    });
});

describe("invite_dealer_onboarding", () => {
    it("preview names the dealer and the number that will be messaged", async () => {
        prepareOnboardingInvite.mockResolvedValue({ ok: true, target: { applicationId: "app-1", waPhone: "919876543210", dealerName: "Ramesh" } });
        await run(ISR, "invite_dealer_onboarding", { lead_id: "DL-7" });
        expect(stored().preview.lines).toEqual([{ label: "Dealer", value: "Ramesh" }, { label: "WhatsApp", value: "+919876543210" }]);
        expect(stored().preview.warning).toMatch(/sends the dealer a WhatsApp message/);
    });

    it("not converted yet → declined", async () => {
        prepareOnboardingInvite.mockResolvedValue({ ok: false, reason: "no_application" });
        expect((await run(ISR, "invite_dealer_onboarding", { lead_id: "DL-7" })).kind).toBe("declined");
    });

    it("applier: sends ONLY after commit, and reports delivery", async () => {
        sendOnboardingInvite.mockResolvedValue({ ok: false, sessionId: "s-1", error: "not on WhatsApp" });
        const plan = APPLIERS.invite_dealer_onboarding.schema.parse({ lead_id: "DL-7", application_id: "app-1", wa_phone: "919876543210", dealer_name: "Ramesh" });
        const out = await APPLIERS.invite_dealer_onboarding.apply({ tx: TX, user: ISR, step: 1 }, plan);
        expect(sendOnboardingInvite).not.toHaveBeenCalled();
        expect(await out.afterCommit!()).toEqual({ delivered: false, session_id: "s-1", error: "not on WhatsApp" });
    });
});

describe("create_lead", () => {
    it("tenDigitPhone accepts +91 / 0-prefixed numbers only as 10 digits", () => {
        expect(tenDigitPhone("+91 98765 43210")).toBe("9876543210");
        expect(tenDigitPhone("098765 43210")).toBe("9876543210");
        expect(tenDigitPhone("98765")).toBeNull();
    });

    it("ISR → claim pool; ASM → owned by them; no lead id on the pending action", async () => {
        await run(ISR, "create_lead", { dealer_name: "Suresh", phone: "+91 98765 43210", city: "Nashik" });
        expect(stored()).toMatchObject({ tool: "create_lead", leadId: null, plan: { phone: "9876543210", city: "Nashik" } });
        expect(stored().preview.lines).toContainEqual({ label: "Goes to", value: "the unassigned claim pool" });
        await run(ASM, "create_lead", { dealer_name: "Suresh", phone: "9876543210" });
        expect(stored().preview.lines).toContainEqual({ label: "Goes to", value: "your queue — owned by you" });
    });

    it("an existing phone → declined; the lead is named only if the user can see it", async () => {
        findLeadIdByPhone.mockResolvedValue("DL-99");
        findLeadInScope.mockResolvedValue(null);
        const hidden = await run(ISR, "create_lead", { dealer_name: "Suresh", phone: "9876543210" });
        expect(hidden).toEqual({ kind: "declined", reason: "A lead with this number already exists.", crm_url: null });
        findLeadInScope.mockResolvedValue(lead({ id: "DL-99" }));
        const seen = await run(ISR, "create_lead", { dealer_name: "Suresh", phone: "9876543210" });
        expect((seen as { reason: string }).reason).toMatch(/ABC Traders/);
        expect(createPending).not.toHaveBeenCalled();
    });

    it("applier: a duplicate created meanwhile → duplicate_phone; otherwise returns the new lead", async () => {
        const plan = APPLIERS.create_lead.schema.parse({
            dealer_name: "Suresh", phone: "9876543210", shop_name: null, city: null, state: null,
            interest_level: null, language: null, business_type: null,
        });
        createInsideSalesLead.mockRejectedValueOnce(new DuplicatePhoneError());
        await expect(APPLIERS.create_lead.apply({ tx: TX, user: ISR, step: 1 }, plan)).rejects.toEqual(new ActionRejected("duplicate_phone"));
        const afterCommit = vi.fn();
        createInsideSalesLead.mockResolvedValueOnce({ id: "DL-new", businessTypeSaved: undefined, afterCommit });
        const out = await APPLIERS.create_lead.apply({ tx: TX, user: ISR, step: 1 }, plan);
        expect(out).toMatchObject({ lead_id: "DL-new", afterCommit });
        expect(String(out.crm_url)).toMatch(/\/inside-sales\/lead\/DL-new$/);
        expect(APPLIERS.create_lead.ownership).toBe("none");
    });
});

describe("confirmed replies", () => {
    const confirmed = (tool: string, extra: Record<string, unknown> | null = null) =>
        renderTapOutcome({
            kind: "confirmed", actionId: "a", tool: tool as never, leadId: "DL-7", title: "Mark Converted — ABC",
            after: {}, crmUrl: "https://crm/lead/DL-7", extra,
        });

    it("after a conversion: a Send invite button (a proposal, not a send), with no action id", () => {
        const p = confirmed("mark_converted");
        expect(p).toMatchObject({ kind: "buttons", buttons: [{ id: "ast:inv:DL-7", title: "Send invite" }] });
        expect(p.kind === "buttons" && p.actionId).toBeFalsy();
    });

    it("the invite reports whether it went out", () => {
        expect(confirmed("invite_dealer_onboarding", { delivered: true }).body).toMatch(/invite sent/);
        expect(confirmed("invite_dealer_onboarding", { delivered: false, error: "not on WhatsApp" }).body).toMatch(/could not be sent \(not on WhatsApp\)/);
    });

    it("every new rejection reason says nothing was saved", () => {
        for (const reason of ["duplicate_phone", "target_unavailable"] as const) {
            expect(renderTapOutcome({ kind: "rejected", reason }).body).toMatch(/nothing was saved/i);
        }
    });
});
