import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// db: claim_lead's pool lookup is the only direct query.
const poolRows: Record<string, unknown>[] = [];
const execute = vi.fn<(q: SQL) => Promise<Record<string, unknown>[]>>(async () => poolRows);
vi.mock("@/lib/db", () => ({ db: { execute } }));
const findLeadInScope = vi.fn();
vi.mock("../scope", async (orig) => ({ ...(await orig<typeof import("../scope")>()), findLeadInScope }));
const createPending = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ id: "act-1", expiresAt: new Date() }));
vi.mock("../actions", async (orig) => ({ ...(await orig<typeof import("../actions")>()), createPending }));
const logLeadTouchpoint = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ touchpointId: "tp-1", historyId: "h-1" }));
vi.mock("@/lib/inside-sales/logTouchpoint", async (orig) => ({ ...(await orig<typeof import("@/lib/inside-sales/logTouchpoint")>()), logLeadTouchpoint }));
const markLeadLost = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => {});
vi.mock("@/lib/leads/markLost", async (orig) => ({ ...(await orig<typeof import("@/lib/leads/markLost")>()), markLeadLost }));
const setInterestLevel = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ changed: true }));
vi.mock("@/lib/leads/interestLevel", () => ({ setInterestLevel }));
const recordVisit = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ visitId: "v-1", scheduledVisitId: "v-2" }));
const scheduleVisit = vi.fn();
vi.mock("@/lib/asm/recordVisit", () => ({ recordVisit, scheduleVisit }));
const claimLead = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ ok: true }));
vi.mock("@/lib/inside-sales/claimLead", () => ({ claimLead }));

const { toolsFor } = await import("../registry");
const { APPLIERS } = await import("../appliers");
const { ActionRejected } = await import("../applierSpec");
import { WRITE_TOOL_NAMES, type AssistantUser, type Preview, type ToolContext } from "../types";

const ISR: AssistantUser = { id: "isr-1", name: "Priya", role: "inside_sales_rep" };
const ASM: AssistantUser = { id: "asm-1", name: "Rahul", role: "asm" };
// Thu 24 Sep 2026, 17:30 IST.
const NOW = new Date("2026-09-24T12:00:00Z");
const ctx = (user: AssistantUser): ToolContext => ({ user, messageId: "11111111-1111-4111-8111-111111111111", now: NOW, writesEnabled: true });
const lead = (over: Record<string, unknown> = {}) => ({
    id: "DL-1042", shop_name: "ABC Traders", dealer_name: "Ramesh", current_owner_id: "asm-1", asm_id: "asm-1",
    lead_status: "Under_Discussion", interest_level: "warm", next_follow_up_at: null,
    updated_at: new Date("2026-09-24T10:00:00Z"), owned: true, ...over,
});

const tool = (user: AssistantUser, name: string) => toolsFor(user.role, true).find((t) => t.name === name)!;
const run = async (user: AssistantUser, name: string, input: Record<string, unknown>) => {
    const t = tool(user, name);
    return t.run(ctx(user), t.schema.parse(input));
};
const stored = () =>
    createPending.mock.calls.at(-1)![0] as { plan: Record<string, unknown>; preview: Preview; tool: string; before: Record<string, unknown>; leadVersion: Date | null };
const sqlText = (q: SQL) => new PgDialect().sqlToQuery(q).sql;

beforeEach(() => {
    vi.clearAllMocks();
    poolRows.length = 0;
    findLeadInScope.mockResolvedValue(lead());
});

// ── log_visit ───────────────────────────────────────────────────────────────

const UC01 = {
    lead_id: "DL-1042", visit_status: "visited", outcome: "productive", interest: "hot",
    remarks: "owner Ramesh, needs 10 batteries at X", next_action: "next_visit", next_visit_date: "2026-09-25",
};

describe("log_visit proposals (UC-01)", () => {
    it("is an ASM tool only", () => {
        expect(tool(ISR, "log_visit")).toBeUndefined();
        expect(tool(ASM, "log_visit")).toBeDefined();
    });

    it("UC-01: visited · productive, interest hot, next visit Friday — ONE pending action, the BRD preview", async () => {
        const r = await run(ASM, "log_visit", UC01);
        expect(r.kind).toBe("preview");
        expect(createPending).toHaveBeenCalledTimes(1);
        const a = stored();
        expect(a.tool).toBe("log_visit");
        expect(a.leadVersion).toEqual(new Date("2026-09-24T10:00:00Z"));
        expect(a.plan).toEqual({
            lead_id: "DL-1042", visit_status: "visited", visit_outcome: "productive", visit_date: "2026-09-24",
            remarks: "owner Ramesh, needs 10 batteries at X", next_action: "next_visit", next_visit_date: "2026-09-25",
            // Already Under_Discussion, and the ASM stated the interest: nothing auto.
            interest: "hot", status_to: null, lost: null, auto: { status: false, interest: false },
        });
        expect(a.preview).toMatchObject({ title: "Log visit — ABC Traders", resets_idle_clock: true, warning: null, needs_second_confirm: false });
        expect(a.preview.lines).toEqual([
            { label: "Visit", value: "visited · productive" },
            { label: "Status", value: "no change" },
            { label: "Temperature", value: "warm → hot" },
            { label: "Next visit", value: "Fri 25 Sep (goes to Today's Schedule)" },
            { label: "Remarks", value: "owner Ramesh, needs 10 batteries at X" },
        ]);
        expect(a.before).toEqual({ lead_status: "Under_Discussion", interest_level: "warm", asm_id: "asm-1" });
    });

    it("an earlier visit day is dated as said and shown; the next visit must still be after it", async () => {
        await run(ASM, "log_visit", { ...UC01, visit_date: "2026-09-23" });
        expect(stored().plan).toMatchObject({ visit_date: "2026-09-23" });
        expect(stored().preview.lines[0]).toEqual({ label: "Visit", value: "visited · productive (Wed 23 Sep)" });
    });

    it("§9.3 row 7: commercials progressed asks which, then proposes the status on its own touchpoint", async () => {
        const base = { ...UC01, outcome: "commercials_progressed", interest: undefined };
        expect((await run(ASM, "log_visit", base)).kind).toBe("question");
        await run(ASM, "log_visit", { ...base, status: "Commercials_Finalised" });
        expect(stored().plan).toMatchObject({ status_to: "Commercials_Finalised", lost: null });
        expect(stored().preview.lines).toContainEqual({ label: "Status", value: "Under Discussion → Commercials Finalised" });
    });

    it("§9.3 row 8: dealer uninterested → Lost with the reason; notes are the remarks", async () => {
        await run(ASM, "log_visit", {
            ...UC01, outcome: "dealer_uninterested", status: "Lost", lost_reason: "not_interested",
            next_action: "lost", next_visit_date: undefined, interest: undefined,
        });
        expect(stored().plan).toMatchObject({
            lost: { reason: "not_interested", notes: "owner Ramesh, needs 10 batteries at X" }, next_action: "lost", next_visit_date: null,
        });
        expect(stored().preview.lines).toContainEqual({ label: "Status", value: "Under Discussion → Lost (not interested)" });
    });

    it("INV6 + date and next-step sanity: every doubtful case is a question and creates NOTHING", async () => {
        const cases: Record<string, unknown>[] = [
            { outcome: "scheduling_issue" }, // outcome outside the §9.3 visit rows
            { outcome: "other" },
            { outcome: "dealer_uninterested" }, // keep open or Lost?
            { outcome: "dealer_uninterested", status: "Lost" }, // why?
            { outcome: "dealer_uninterested", status: "Lost", lost_reason: "price_high", next_action: "lost", next_visit_date: undefined }, // not a visit reason
            { outcome: "productive", status: "Commercials_Explained" }, // productive = no change only
            { outcome: "dealer_uninterested", status: "Lost", lost_reason: "not_interested" }, // Lost but a next visit
            { next_action: "lost", next_visit_date: undefined }, // lost next step, lead not Lost
            { next_visit_date: "2026-09-24" }, // same day as the visit: recordVisit would not schedule it
            { next_visit_date: "2026-09-20" }, // past
            { next_visit_date: "2027-03-01" }, // > 90 days
            { visit_date: "2026-09-26" }, // a visit in the future
            { visit_date: "2026-01-01" }, // > 90 days ago
            { visit_status: "no_show", outcome: undefined, status: "Lost", lost_reason: "not_interested" }, // no visit, no status
            { visit_status: "postponed", outcome: undefined, next_visit_date: "2026-09-24" }, // must be after today
        ];
        for (const c of cases) {
            const r = await run(ASM, "log_visit", { ...UC01, ...c });
            expect(r.kind, JSON.stringify(c)).toBe("question");
        }
        expect(createPending).not.toHaveBeenCalled();
    });

    it("a visit that didn't happen carries no outcome and no date, like the screen sends it", async () => {
        await run(ASM, "log_visit", { ...UC01, visit_status: "no_show", outcome: "dealer_not_present", interest: undefined });
        expect(stored().plan).toMatchObject({ visit_status: "no_show", visit_outcome: null, visit_date: null, next_visit_date: "2026-09-25" });
        expect(stored().preview.lines[0]).toEqual({ label: "Visit", value: "no show" });
    });

    it("UC-11: next step 'convert' is declined with the lead's link; nothing proposed", async () => {
        const r = await run(ASM, "log_visit", { ...UC01, next_action: "convert", next_visit_date: undefined });
        expect(r).toMatchObject({ kind: "declined", crm_url: expect.stringContaining("/asm/lead/DL-1042") });
        expect(createPending).not.toHaveBeenCalled();
    });

    it("warns when the next visit won't reach Today's Schedule; escalate says where to raise it", async () => {
        findLeadInScope.mockResolvedValue(lead({ asm_id: null }));
        await run(ASM, "log_visit", UC01);
        expect(stored().preview.warning).toMatch(/won't show in your Today's Schedule/);
        findLeadInScope.mockResolvedValue(lead());
        await run(ASM, "log_visit", { ...UC01, next_action: "escalate", next_visit_date: undefined });
        expect(stored().preview.warning).toMatch(/escalation itself on the CRM screen/);
    });

    it("not owned / out of scope / pilot off: no pending action", async () => {
        findLeadInScope.mockResolvedValue(lead({ owned: false, current_owner_id: "asm-2" }));
        expect((await run(ASM, "log_visit", UC01)).kind).toBe("declined");
        findLeadInScope.mockResolvedValue(null);
        expect(await run(ASM, "log_visit", UC01)).toEqual({ kind: "not_found" });
        const t = tool(ASM, "log_visit");
        expect((await t.run({ ...ctx(ASM), writesEnabled: false }, t.schema.parse(UC01))).kind).toBe("declined");
        expect(createPending).not.toHaveBeenCalled();
    });
});

// ── mark_lost ───────────────────────────────────────────────────────────────

describe("mark_lost proposals", () => {
    it("from → Lost with the reason; a status change resets the idle clock", async () => {
        const r = await run(ISR, "mark_lost", { lead_id: "DL-1042", lost_reason: "not_interested", notes: "bought elsewhere" });
        expect(r.kind).toBe("preview");
        expect(stored().plan).toEqual({ lead_id: "DL-1042", reason: "not_interested", notes: "bought elsewhere" });
        expect(stored().preview).toMatchObject({ title: "Mark Lost — ABC Traders", resets_idle_clock: true, needs_second_confirm: false, warning: null });
        expect(stored().preview.lines).toEqual([
            { label: "Status", value: "Under Discussion → Lost (not interested)" },
            { label: "Notes", value: "bought elsewhere" },
        ]);
    });

    it("the four high-impact reasons are flagged for a second confirm, with the consequence", async () => {
        for (const reason of ["business_closed", "duplicate_lead", "rejected_by_us_credit", "rejected_by_us_geography"]) {
            await run(ISR, "mark_lost", { lead_id: "DL-1042", lost_reason: reason });
            expect(stored().preview.needs_second_confirm, reason).toBe(true);
            expect(stored().preview.warning, reason).toMatch(/High-impact/);
        }
    });

    it("'other' needs notes (a question); onboarding_dropout is not a reason a rep can pick", async () => {
        expect((await run(ISR, "mark_lost", { lead_id: "DL-1042", lost_reason: "other" })).kind).toBe("question");
        expect((await run(ISR, "mark_lost", { lead_id: "DL-1042", lost_reason: "other", notes: "   " })).kind).toBe("question");
        expect(tool(ISR, "mark_lost").schema.safeParse({ lead_id: "DL-1042", lost_reason: "onboarding_dropout" }).success).toBe(false);
        expect(createPending).not.toHaveBeenCalled();
    });

    it("already Lost / Converted / not owned / out of scope: declined or not_found, nothing proposed", async () => {
        findLeadInScope.mockResolvedValue(lead({ lead_status: "Lost" }));
        expect(await run(ISR, "mark_lost", { lead_id: "DL-1042", lost_reason: "price_high" })).toMatchObject({ kind: "declined" });
        findLeadInScope.mockResolvedValue(lead({ lead_status: "Converted" }));
        expect(await run(ISR, "mark_lost", { lead_id: "DL-1042", lost_reason: "price_high" })).toMatchObject({ kind: "declined" });
        findLeadInScope.mockResolvedValue(lead({ owned: false, current_owner_id: "isr-2" }));
        expect((await run(ISR, "mark_lost", { lead_id: "DL-1042", lost_reason: "price_high" })).kind).toBe("declined");
        findLeadInScope.mockResolvedValue(null);
        expect(await run(ISR, "mark_lost", { lead_id: "DL-1042", lost_reason: "price_high" })).toEqual({ kind: "not_found" });
        expect(createPending).not.toHaveBeenCalled();
    });
});

// ── claim_lead ──────────────────────────────────────────────────────────────

const poolLead = (over: Record<string, unknown> = {}) => ({
    id: "DL-7", shop_name: "Sharma Battery House", dealer_name: "Sharma", city: "Pune", lead_status: "New_Unassigned",
    interest_level: null, updated_at: "2026-09-24T09:00:00Z", total: 1, ...over,
});

describe("claim_lead proposals (UC-05)", () => {
    it("UC-05: a name resolved in the POOL → one preview (owner you, Assigned Not Contacted)", async () => {
        poolRows.push(poolLead());
        const r = await run(ISR, "claim_lead", { name: "Sharma Battery House" });
        expect(r.kind).toBe("preview");
        expect(stored().plan).toEqual({ lead_id: "DL-7" });
        expect(stored().leadVersion).toEqual(new Date("2026-09-24T09:00:00Z"));
        expect(stored().preview.title).toBe("Claim — Sharma Battery House");
        expect(stored().preview.lines).toContainEqual({ label: "Status", value: "New Unassigned → Assigned Not Contacted" });
        expect(stored().preview.lines).toContainEqual({ label: "Owner", value: "you" });
        // The lookup is the claim pool, never the whole scope.
        const q = sqlText(execute.mock.calls[0]![0]);
        expect(q).toContain("dl.current_owner_id IS NULL");
        expect(q).toMatch(/ILIKE/);
    });

    it("an ASM's pool is in-territory only; the preview makes them the field ASM", async () => {
        poolRows.push(poolLead({ lead_status: null }));
        await run(ASM, "claim_lead", { lead_id: "DL-7" });
        const q = sqlText(execute.mock.calls[0]![0]);
        expect(q).toContain("asm_territories");
        expect(q).not.toMatch(/OR dl\.current_owner_id IS NULL/); // the Territory Feed's read-only widening
        expect(stored().preview.lines).toContainEqual({ label: "Status", value: "New Unassigned → Assigned Not Contacted" });
        expect(stored().preview.lines).toContainEqual({ label: "Field ASM", value: "you (visits go to your Today's Schedule)" });
    });

    it("two matches → candidates, never a pick; no match by name → not_found", async () => {
        poolRows.push(poolLead({ total: 2 }), poolLead({ id: "DL-8", shop_name: "Sharma Battery House 2", total: 2 }));
        const r = await run(ISR, "claim_lead", { name: "Sharma" });
        expect(r.kind).toBe("candidates");
        if (r.kind === "candidates") expect(r.rows.map((x) => x.id)).toEqual(["DL-7", "DL-8"]);
        poolRows.length = 0;
        expect(await run(ISR, "claim_lead", { name: "Nobody" })).toEqual({ kind: "not_found" });
        expect(createPending).not.toHaveBeenCalled();
    });

    it("an id outside the pool: out of scope = not_found; in scope = the reason (ASM: territory)", async () => {
        findLeadInScope.mockResolvedValue(null);
        expect(await run(ASM, "claim_lead", { lead_id: "DL-9" })).toEqual({ kind: "not_found" });
        findLeadInScope.mockResolvedValue(lead({ current_owner_id: null, owned: false }));
        expect(await run(ASM, "claim_lead", { lead_id: "DL-9" })).toMatchObject({ kind: "declined", reason: expect.stringMatching(/outside your territory/) });
        findLeadInScope.mockResolvedValue(lead({ current_owner_id: "isr-2", owned: false }));
        expect(await run(ISR, "claim_lead", { lead_id: "DL-9" })).toMatchObject({ kind: "declined", reason: expect.stringMatching(/already has an owner/) });
        findLeadInScope.mockResolvedValue(lead({ current_owner_id: "isr-1", owned: true }));
        expect(await run(ISR, "claim_lead", { lead_id: "DL-9" })).toMatchObject({ kind: "declined", reason: "You already own this lead." });
        expect(createPending).not.toHaveBeenCalled();
    });

    it("needs a lead id or a name; pilot off → declined before any lookup", async () => {
        expect(tool(ISR, "claim_lead").schema.safeParse({}).success).toBe(false);
        const t = tool(ISR, "claim_lead");
        expect((await t.run({ ...ctx(ISR), writesEnabled: false }, t.schema.parse({ name: "Sharma" }))).kind).toBe("declined");
        expect(execute).not.toHaveBeenCalled();
    });
});

// ── Appliers ────────────────────────────────────────────────────────────────

describe("gate 5 appliers (run inside the executor's transaction)", () => {
    const txExecute = vi.fn(async () => [{ id: "DL-7" }]);
    const TX = { fake: "tx", execute: txExecute };
    const apply = (t: "log_visit" | "mark_lost" | "claim_lead", user: AssistantUser, plan: unknown, step: 1 | 2 = 1) =>
        APPLIERS[t].apply({ tx: TX as never, user, step }, APPLIERS[t].schema.parse(plan));
    const visitPlan = {
        lead_id: "DL-1042", visit_status: "visited", visit_outcome: "productive", visit_date: "2026-09-24",
        remarks: "owner Ramesh", next_action: "next_visit", next_visit_date: "2026-09-25",
        interest: "hot", status_to: null, lost: null,
    };

    it("every write tool has an applier", () => {
        for (const t of WRITE_TOOL_NAMES) expect(APPLIERS[t], t).toBeDefined();
    });

    it("UC-01: visit (+ scheduled next visit) and interest on the SAME tx; the IST visit day is passed explicitly", async () => {
        const after = await apply("log_visit", ASM, visitPlan);
        expect(recordVisit).toHaveBeenCalledWith(
            {
                leadId: "DL-1042", asmId: "asm-1", visit_status: "visited", visit_outcome: "productive",
                actual_visit_date: "2026-09-24", visit_remarks: "owner Ramesh", next_action: "next_visit", next_visit_date: "2026-09-25",
            },
            { tx: TX },
        );
        expect(setInterestLevel).toHaveBeenCalledWith(expect.objectContaining({ leadId: "DL-1042", level: "hot" }), { tx: TX });
        expect(logLeadTouchpoint).not.toHaveBeenCalled();
        expect(markLeadLost).not.toHaveBeenCalled();
        expect(after).toEqual({ visit_id: "v-1", scheduled_visit_id: "v-2", status_history_id: null });
    });

    it("status change and Lost go on the same tx, AFTER the visit; high-impact only at step 2", async () => {
        await apply("log_visit", ASM, { ...visitPlan, interest: null, status_to: "Commercials_Explained" });
        expect(logLeadTouchpoint).toHaveBeenCalledWith(
            expect.objectContaining({ body: expect.objectContaining({ touchpoint_type: "status_change_note", status_change: { to: "Commercials_Explained" } }) }),
            { tx: TX },
        );
        vi.clearAllMocks();
        const lost = { ...visitPlan, next_action: "lost", next_visit_date: null, lost: { reason: "not_interested", notes: "x" } };
        await apply("log_visit", ASM, lost);
        expect(recordVisit.mock.invocationCallOrder[0]).toBeLessThan(markLeadLost.mock.invocationCallOrder[0]!);
        expect(markLeadLost).toHaveBeenCalledWith(expect.objectContaining({ reason: "not_interested", confirmedHighImpact: false }), { tx: TX });
        expect(APPLIERS.log_visit.needsSecondConfirm(APPLIERS.log_visit.schema.parse(lost))).toBe(false);
    });

    it("a visit plan can't be applied by an ISR; a tampered plan (convert) is refused by the schema", async () => {
        await expect(apply("log_visit", ISR, visitPlan)).rejects.toThrow(/role/);
        expect(() => APPLIERS.log_visit.schema.parse({ ...visitPlan, next_action: "convert" })).toThrow();
        expect(recordVisit).not.toHaveBeenCalled();
    });

    it("mark_lost: markLeadLost on the tx; confirmedHighImpact ONLY at step 2", async () => {
        const plan = { lead_id: "DL-1042", reason: "duplicate_lead", notes: null };
        expect(APPLIERS.mark_lost.needsSecondConfirm(APPLIERS.mark_lost.schema.parse(plan))).toBe(true);
        expect(APPLIERS.mark_lost.secondConfirmWarning(APPLIERS.mark_lost.schema.parse(plan))).toMatch(/Tap Confirm again/);
        await apply("mark_lost", ISR, plan, 2);
        expect(markLeadLost).toHaveBeenCalledWith(
            { leadId: "DL-1042", actor: { id: "isr-1", role: "inside_sales_rep" }, reason: "duplicate_lead", notes: null, confirmedHighImpact: true },
            { tx: TX },
        );
        expect(() => APPLIERS.mark_lost.schema.parse({ ...plan, reason: "onboarding_dropout" })).toThrow();
    });

    it("claim_lead: pool re-check on the locked row (tx), then claimLead on the tx with the role", async () => {
        expect(APPLIERS.claim_lead.ownership).toBe("claim");
        expect(await APPLIERS.claim_lead.assertClaimable(TX as never, "DL-7", ASM)).toBe(true);
        expect(sqlText((txExecute.mock.calls as unknown as [SQL][])[0]![0])).toContain("asm_territories");
        txExecute.mockResolvedValueOnce([]);
        expect(await APPLIERS.claim_lead.assertClaimable(TX as never, "DL-7", ASM)).toBe(false);

        await apply("claim_lead", ASM, { lead_id: "DL-7" });
        expect(claimLead).toHaveBeenCalledWith("DL-7", "asm-1", { tx: TX, actorRole: "asm" });
        claimLead.mockResolvedValueOnce({ ok: false, reason: "already_owned" });
        await expect(apply("claim_lead", ISR, { lead_id: "DL-7" })).rejects.toBeInstanceOf(ActionRejected);
    });
});
