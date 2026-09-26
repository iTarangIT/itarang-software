import { beforeEach, describe, expect, it, vi } from "vitest";

// db: only setFollowUp's "already scheduled?" select touches it directly.
const existingVisits: { id: string }[] = [];
vi.mock("@/lib/db", () => {
    const chain = { from: () => chain, where: () => chain, limit: async () => existingVisits };
    return { db: { select: () => chain } };
});
const findLeadInScope = vi.fn();
vi.mock("../scope", async (orig) => ({ ...(await orig<typeof import("../scope")>()), findLeadInScope }));
const createPending = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ id: "act-1", expiresAt: new Date() }));
vi.mock("../actions", async (orig) => ({ ...(await orig<typeof import("../actions")>()), createPending }));
const logLeadTouchpoint = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ touchpointId: "tp-1", historyId: null }));
vi.mock("@/lib/inside-sales/logTouchpoint", async (orig) => ({ ...(await orig<typeof import("@/lib/inside-sales/logTouchpoint")>()), logLeadTouchpoint }));
const markLeadLost = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => {});
vi.mock("@/lib/leads/markLost", async (orig) => ({ ...(await orig<typeof import("@/lib/leads/markLost")>()), markLeadLost }));
const setInterestLevel = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ changed: true }));
vi.mock("@/lib/leads/interestLevel", () => ({ setInterestLevel }));
const scheduleVisit = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ visitId: "v-1" }));
vi.mock("@/lib/asm/recordVisit", () => ({ scheduleVisit, recordVisit: vi.fn() }));

const { toolsFor } = await import("../registry");
const { APPLIERS } = await import("../appliers");
const { renderPreview, renderTapOutcome, RENDER_LIMITS } = await import("@/lib/wa-assistant/render");
import type { AssistantUser, Preview, ToolContext, ToolResult } from "../types";

const ISR: AssistantUser = { id: "isr-1", name: "Priya", role: "inside_sales_rep" };
const ASM: AssistantUser = { id: "asm-1", name: "Rahul", role: "asm" };
// Thu 24 Sep 2026, 17:30 IST.
const NOW = new Date("2026-09-24T12:00:00Z");
const ctx = (user: AssistantUser): ToolContext => ({ user, messageId: "11111111-1111-4111-8111-111111111111", now: NOW, writesEnabled: true });
const lead = (over: Record<string, unknown> = {}) => ({
    id: "DL-1", shop_name: "Shree Motors", dealer_name: "Ramesh", current_owner_id: "isr-1", asm_id: null,
    lead_status: "Under_Discussion", interest_level: "warm", next_follow_up_at: null,
    updated_at: new Date("2026-09-24T10:00:00Z"), owned: true, ...over,
});

const tool = (user: AssistantUser, name: string) => toolsFor(user.role, true).find((t) => t.name === name)!;
const run = async (user: AssistantUser, name: string, input: Record<string, unknown>) => {
    const t = tool(user, name);
    return t.run(ctx(user), t.schema.parse(input));
};
const stored = () => createPending.mock.calls.at(-1)![0] as { plan: Record<string, unknown>; preview: Preview; leadVersion: Date; before: Record<string, unknown>; tool: string };

beforeEach(() => {
    vi.clearAllMocks();
    existingVisits.length = 0;
    findLeadInScope.mockResolvedValue(lead());
});

describe("log_call proposals (UC-02, UC-03)", () => {
    it("UC-02: 'not interested, price too high' → call (Price High) + Lost price_high, one pending action", async () => {
        const r = await run(ISR, "log_call", {
            lead_id: "DL-1", channel: "call", connect_status: "connected", disposition: "Price High", bucket: "Warm",
            status: "Lost", remarks: "price too high",
        });
        expect(r.kind).toBe("preview");
        expect(createPending).toHaveBeenCalledTimes(1);
        const a = stored();
        expect(a.tool).toBe("log_call");
        expect(a.leadVersion).toEqual(new Date("2026-09-24T10:00:00Z"));
        expect(a.plan).toMatchObject({
            touchpoint_type: "inside_sales_call",
            disposition: { connect_status: "connected", label: "Price High", bucket: "Warm" },
            status_to: null,
            lost: { reason: "price_high", notes: "price too high" },
            follow_up_at: null,
        });
        expect(a.preview.lines).toContainEqual({ label: "Status", value: "Under Discussion → Lost (price high)" });
        expect(a.preview.resets_idle_clock).toBe(true);
        expect(a.preview.needs_second_confirm).toBe(false);
        expect(a.before).toMatchObject({ lead_status: "Under_Discussion", interest_level: "warm" });
    });

    it("UC-03: 'nahi uthaya, kal 11 baje' → not connected, no status change, follow-up tomorrow 11:00 IST stored as UTC", async () => {
        const r = await run(ISR, "log_call", {
            lead_id: "DL-1", channel: "call", connect_status: "not_connected", disposition: "Did not pick",
            follow_up_at: "2026-09-25T11:00:00+05:30",
        });
        expect(r.kind).toBe("preview");
        expect(stored().plan).toMatchObject({ status_to: null, lost: null, follow_up_at: "2026-09-25T05:30:00.000Z" });
        expect(stored().preview.lines).toEqual([
            { label: "Call", value: "not connected · Did not pick" },
            { label: "Status", value: "no change" },
            { label: "Follow-up", value: "Fri 25 Sep, 11:00" },
        ]);
        expect(stored().preview.resets_idle_clock).toBe(true);
    });

    it("INV6: anything outside the §9.3 map becomes a question and creates NOTHING", async () => {
        const cases: Record<string, unknown>[] = [
            { channel: "call", connect_status: "connected", disposition: "Commercials Explained" }, // warm or hot?
            { channel: "call", connect_status: "connected", disposition: "Price High", bucket: "Warm" }, // still talking or lost?
            { channel: "call", connect_status: "connected", disposition: "As to Call Back", bucket: "Cold", status: "Converted" },
            { channel: "call", connect_status: "not_connected", disposition: "Switch off", status: "Lost" },
            { channel: "call", connect_status: "connected", disposition: "REJECTED BY US", bucket: "Lost", status: "Lost" },
            { channel: "call", connect_status: "not_connected", disposition: "Did not pick", follow_up_at: "2026-09-20T11:00:00+05:30" }, // past
            { channel: "call", connect_status: "not_connected", disposition: "Did not pick", follow_up_at: "2027-06-01T11:00:00+05:30" }, // > 90 days
            { channel: "call", connect_status: "connected", disposition: "Not Interested", bucket: "Lost", status: "Lost", follow_up_at: "2026-09-25T11:00:00+05:30" },
            { channel: "call", connect_status: "connected", disposition: "Lost to Competition", bucket: "Lost", status: "Lost" }, // 'other' needs notes
            { channel: "note", status: "Lost" },
            { channel: "note" },
        ];
        for (const c of cases) {
            const r = await run(ISR, "log_call", { lead_id: "DL-1", ...c });
            expect(r.kind, JSON.stringify(c)).toBe("question");
        }
        expect(createPending).not.toHaveBeenCalled();
    });

    it("a high-impact Lost reason is flagged for a second confirm, with its consequence", async () => {
        await run(ISR, "log_call", {
            lead_id: "DL-1", channel: "call", connect_status: "connected", disposition: "Business Closed", bucket: "Lost", status: "Lost",
        });
        expect(stored().plan).toMatchObject({ lost: { reason: "business_closed" } });
        expect(stored().preview.needs_second_confirm).toBe(true);
        expect(stored().preview.warning).toMatch(/excluded from the AI dialer/);
    });

    it("quote sent proposes interest hot; an interest already set is not re-proposed", async () => {
        await run(ISR, "log_call", {
            lead_id: "DL-1", channel: "call", connect_status: "connected", disposition: "Quotation Sent", bucket: "Hot",
            status: "Awaiting_Customer_Decision",
        });
        expect(stored().plan).toMatchObject({ interest: "hot", status_to: "Awaiting_Customer_Decision" });
        findLeadInScope.mockResolvedValue(lead({ interest_level: "hot" }));
        await run(ISR, "log_call", { lead_id: "DL-1", channel: "note", remarks: "x", interest: "hot" });
        expect(stored().plan).toMatchObject({ interest: null });
    });

    it("not owned / out of scope / pilot off: no pending action", async () => {
        findLeadInScope.mockResolvedValue(lead({ owned: false, current_owner_id: "isr-2" }));
        expect((await run(ISR, "log_call", { lead_id: "DL-1", channel: "note", remarks: "x" })).kind).toBe("declined");
        findLeadInScope.mockResolvedValue(null);
        expect(await run(ISR, "log_call", { lead_id: "DL-1", channel: "note", remarks: "x" })).toEqual({ kind: "not_found" });
        const t = tool(ISR, "log_call");
        expect((await t.run({ ...ctx(ISR), writesEnabled: false }, t.schema.parse({ lead_id: "DL-1", channel: "note", remarks: "x" }))).kind).toBe("declined");
        expect(createPending).not.toHaveBeenCalled();
    });
});

describe("set_follow_up proposals (UC-07)", () => {
    it("ISR: follow-up instant → isr_follow_up plan", async () => {
        const r = await run(ISR, "set_follow_up", { lead_id: "DL-1", follow_up_at: "2026-09-28T10:00:00+05:30", note: "send brochure" });
        expect(r.kind).toBe("preview");
        expect(stored().plan).toEqual({ kind: "isr_follow_up", lead_id: "DL-1", follow_up_at: "2026-09-28T04:30:00.000Z", note: "send brochure", status_to: null });
        expect(stored().preview.resets_idle_clock).toBe(false);
    });

    it("UC-07 ASM: 'Schedule Gupta Motors for Monday' → a scheduled visit that goes to Today's Schedule", async () => {
        findLeadInScope.mockResolvedValue(lead({ current_owner_id: "asm-1", asm_id: "asm-1", shop_name: "Gupta Motors" }));
        const r = await run(ASM, "set_follow_up", { lead_id: "DL-1", visit_date: "2026-09-28", note: "discuss quote" });
        expect(r.kind).toBe("preview");
        expect(stored().plan).toEqual({ kind: "asm_visit", lead_id: "DL-1", visit_date: "2026-09-28", note: "discuss quote", status_to: null });
        expect(stored().preview).toMatchObject({ title: "Schedule visit — Gupta Motors", warning: null });
        expect(stored().preview.lines[0]).toEqual({ label: "Visit", value: "Mon 28 Sep (goes to Today's Schedule)" });
    });

    it("ASM: warns when the lead's field ASM isn't them; declines an already-scheduled day; refuses past dates", async () => {
        findLeadInScope.mockResolvedValue(lead({ current_owner_id: "asm-1", asm_id: null }));
        await run(ASM, "set_follow_up", { lead_id: "DL-1", visit_date: "2026-09-28", note: "x" });
        expect(stored().preview.warning).toMatch(/won't show in your Today's Schedule/);
        existingVisits.push({ id: "v" });
        expect((await run(ASM, "set_follow_up", { lead_id: "DL-1", visit_date: "2026-09-28", note: "x" })).kind).toBe("declined");
        existingVisits.length = 0;
        expect((await run(ASM, "set_follow_up", { lead_id: "DL-1", visit_date: "2026-09-20", note: "x" })).kind).toBe("question");
    });
});

describe("appliers (run inside the executor's transaction)", () => {
    const TX = { fake: "tx" };
    const apply = (tool: "log_call" | "set_follow_up", user: AssistantUser, plan: unknown, step: 1 | 2 = 1) =>
        APPLIERS[tool]!.apply({ tx: TX as never, user, step }, APPLIERS[tool]!.schema.parse(plan));
    const callPlan = {
        lead_id: "DL-1", channel: "call", touchpoint_type: "inside_sales_call",
        disposition: { connect_status: "connected", label: "Price High", bucket: "Warm" },
        call_duration_sec: null, remarks: "price too high", status_to: null,
        lost: { reason: "price_high", notes: "price too high" }, follow_up_at: null, interest: null,
    };

    it("UC-02: call touchpoint then Lost — both on the SAME tx", async () => {
        await apply("log_call", ISR, callPlan);
        expect(logLeadTouchpoint).toHaveBeenCalledWith(
            expect.objectContaining({ leadId: "DL-1", actorId: "isr-1", body: expect.objectContaining({ touchpoint_type: "inside_sales_call" }) }),
            { tx: TX },
        );
        expect(markLeadLost).toHaveBeenCalledWith(
            expect.objectContaining({ reason: "price_high", actor: { id: "isr-1", role: "inside_sales_rep" }, confirmedHighImpact: false }),
            { tx: TX },
        );
        expect(setInterestLevel).not.toHaveBeenCalled();
    });

    it("high-impact confirmation is passed ONLY at step 2", async () => {
        const hi = { ...callPlan, lost: { reason: "business_closed", notes: null } };
        expect(APPLIERS.log_call!.needsSecondConfirm(APPLIERS.log_call!.schema.parse(hi))).toBe(true);
        await apply("log_call", ISR, hi, 2);
        expect(markLeadLost).toHaveBeenCalledWith(expect.objectContaining({ confirmedHighImpact: true }), { tx: TX });
    });

    it("UC-03: follow-up rides on the touchpoint (same tx)", async () => {
        await apply("log_call", ISR, { ...callPlan, disposition: { connect_status: "not_connected", label: "Did not pick", bucket: null }, lost: null, follow_up_at: "2026-09-25T05:30:00.000Z" });
        expect(logLeadTouchpoint.mock.calls[0][0]).toMatchObject({
            body: { follow_up_at: "2026-09-25T05:30:00.000Z", next_action: "follow_up", next_action_at: "2026-09-25T05:30:00.000Z" },
        });
        expect(markLeadLost).not.toHaveBeenCalled();
    });

    it("UC-07: ASM visit → scheduleVisit + a note, same tx; a plan can't be applied by the other role", async () => {
        const plan = { kind: "asm_visit", lead_id: "DL-1", visit_date: "2026-09-28", note: "discuss quote" };
        const after = await apply("set_follow_up", ASM, plan);
        expect(scheduleVisit).toHaveBeenCalledWith({ leadId: "DL-1", asmId: "asm-1", date: "2026-09-28", remarks: "discuss quote" }, { tx: TX });
        expect(logLeadTouchpoint).toHaveBeenCalledWith(expect.anything(), { tx: TX });
        expect(after).toEqual({ scheduled_visit_id: "v-1", touchpoint_id: "tp-1" });
        await expect(apply("set_follow_up", ISR, plan)).rejects.toThrow(/role/);
    });

    it("a tampered stored plan is refused before anything is written", async () => {
        // The executor parses the stored plan before it opens the transaction.
        expect(() => APPLIERS.log_call!.schema.parse({ ...callPlan, lost: { reason: "because", notes: null } })).toThrow();
        expect(() => APPLIERS.log_call!.schema.parse({ ...callPlan, touchpoint_type: "quote_sent" })).toThrow();
        expect(logLeadTouchpoint).not.toHaveBeenCalled();
    });
});

describe("preview + tap rendering", () => {
    const preview: Preview = {
        title: "Log call — Shree Motors",
        lines: [{ label: "Call", value: "connected · Price High (Warm)" }, { label: "Remarks", value: "x".repeat(5000) }],
        resets_idle_clock: true, warning: null, needs_second_confirm: false, crm_url: "https://crm/x",
    };

    it("Confirm / Edit / Cancel (Edit in the middle); body ≤ 900 with the footer intact", () => {
        const p = renderPreview(preview, "act-1");
        expect(p.kind).toBe("buttons");
        if (p.kind !== "buttons") return;
        expect(p.buttons).toEqual([
            { id: "ast:c:act-1", title: "Confirm" },
            { id: "ast:e:act-1", title: "Edit" },
            { id: "ast:x:act-1", title: "Cancel" },
        ]);
        expect(p.body.length).toBeLessThanOrEqual(RENDER_LIMITS.previewBody);
        expect(p.body.startsWith("*Log call — Shree Motors*")).toBe(true);
        expect(p.body.endsWith("Resets idle clock: yes · Expires in 10 min")).toBe(true);
    });

    it("no Edit on a high-impact second confirmation or a dealer invite", () => {
        const p = renderPreview(preview, "act-1", { edit: false });
        expect(p.kind === "buttons" && p.buttons.map((b) => b.title)).toEqual(["Confirm", "Cancel"]);
    });

    it("a superseded card's tap says so", () => {
        expect(renderTapOutcome({ kind: "superseded" }).body).toMatch(/replaced by a newer one/);
    });

    it("a preview wins over model text in a turn", async () => {
        const { renderTurn } = await import("@/lib/wa-assistant/render");
        const r = renderTurn({ text: "Saved it for you!", results: [{ tool: "log_call", result: { kind: "preview", action_id: "a", preview } as ToolResult }] });
        expect(r.kind).toBe("buttons");
        expect(r.body).not.toContain("Saved it for you");
    });

    it("UC-15 wording for expired and repeated taps; rejections say nothing was saved", () => {
        expect(renderTapOutcome({ kind: "expired" }).body).toMatch(/expired\. Nothing was saved/);
        expect(renderTapOutcome({ kind: "already_done" }).body).toBe("Already saved.");
        for (const reason of ["stale", "not_owner", "writes_disabled", "lead_missing", "not_claimable"] as const) {
            expect(renderTapOutcome({ kind: "rejected", reason }).body).toMatch(/[Nn]othing was saved/);
        }
    });
});
