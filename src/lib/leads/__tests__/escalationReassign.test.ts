// ID 121 — an escalation resolved with Reassign applies the hand-back rule.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const dialect = new PgDialect();
const statements: string[] = [];
let target: Record<string, unknown> | undefined;
let lead: Record<string, unknown>;
let bookedVisits: Record<string, unknown>[] = [];
let asmFollowUps: Record<string, unknown>[] = [];
let openVisits: Record<string, unknown>[] = [];
const execute = vi.fn(async (q: SQL) => {
    const text = dialect.sqlToQuery(q).sql;
    statements.push(text);
    if (/FROM users/.test(text) && !/lead_visits|lead_touchpoints/.test(text)) return target ? [target] : [];
    if (/^\s*SELECT[\s\S]*FROM lead_visits/.test(text)) return bookedVisits;
    if (/^\s*SELECT[\s\S]*FROM lead_touchpoints/.test(text)) return asmFollowUps;
    if (/^\s*SELECT[\s\S]*FROM dealer_leads/.test(text)) return [lead];
    if (/UPDATE lead_visits/.test(text)) return openVisits;
    return [];
});
const tx = { execute };
vi.mock("@/lib/db", () => ({ db: { execute, transaction: vi.fn() } }));
const writeTouchpoint = vi.fn(async () => ({ touchpointId: "tp", historyId: "h" }));
vi.mock("@/lib/touchpoints/write", () => ({ writeTouchpoint }));
const markSalesReady = vi.fn(async () => true);
vi.mock("@/lib/leads/salesReady", () => ({ markSalesReady }));

const { reassignFromEscalation, EscalationTargetError } = await import("../escalationReassign");
const { AsmVisitBookedError } = await import("../asmHandBack");

const run = () =>
    reassignFromEscalation(tx as never, {
        leadId: "DL-1",
        actorId: "admin-1",
        targetUserId: "rep-2",
        notes: "Escalation resolved — handing back",
    });
const call = () => writeTouchpoint.mock.calls.at(-1) as unknown as [Record<string, unknown>, Record<string, unknown>];
const wrote = () => statements.some((q) => /^\s*UPDATE/.test(q));

beforeEach(() => {
    statements.length = 0;
    target = { id: "rep-2", is_active: true, role: "inside_sales_rep", name: "Ravi" };
    lead = { current_owner_id: "asm-1", lead_status: "Transferred_to_ASM", pre_transfer_status: "Under_Discussion" };
    bookedVisits = [];
    asmFollowUps = [];
    openVisits = [];
    execute.mockClear();
    writeTouchpoint.mockClear();
    markSalesReady.mockClear();
});

describe("reassignFromEscalation", () => {
    it("refuses (409) while the ASM has a visit booked — nothing written", async () => {
        bookedVisits = [{ scheduled_date: "2026-10-13", asm_name: "Suresh" }];
        const err = await run().catch((e) => e);
        expect(err).toBeInstanceOf(AsmVisitBookedError);
        expect(err.status).toBe(409);
        expect(err.message).toMatch(/Suresh has a visit booked for 13 Oct/);
        expect(wrote()).toBe(false);
        expect(writeTouchpoint).not.toHaveBeenCalled();
        expect(markSalesReady).not.toHaveBeenCalled();
    });

    it("refuses (409) while the ASM has a follow-up set — nothing written", async () => {
        asmFollowUps = [{ follow_up_date: "2026-10-14", asm_name: "Suresh" }];
        const err = await run().catch((e) => e);
        expect(err).toBeInstanceOf(AsmVisitBookedError);
        expect(err.message).toMatch(/Suresh has a follow-up set for 14 Oct/);
        expect(wrote()).toBe(false);
    });

    it("with nothing booked: hands back, unlinks the ASM, closes visits, restores the stage", async () => {
        openVisits = [{ visit_id: "v-1" }];
        const out = await run();
        expect(out).toEqual({ handedBack: true, closedVisits: 1 });
        expect(statements.some((q) => /current_owner_id = \$1[\s\S]*pre_transfer_status = NULL/.test(q))).toBe(true);
        expect(statements.some((q) => /asm_id = NULL/.test(q))).toBe(true);
        expect(statements.some((q) => /UPDATE lead_visits[\s\S]*'cancelled'/.test(q))).toBe(true);
        const [input, opts] = call();
        expect(opts).toEqual({ tx });
        expect(input).toMatchObject({
            touchpointType: "escalation_resolved_reassign",
            fromOwnerId: "asm-1",
            toOwnerId: "rep-2",
            statusChange: { from: "Transferred_to_ASM", to: "Under_Discussion", event: "correction" },
        });
        expect((input.statusChange as { reasonNotes: string }).reasonNotes).toMatch(/Ravi[\s\S]*ASM unlinked; 1 open visit closed/);
        expect(markSalesReady).toHaveBeenCalledWith(tx, expect.objectContaining({ leadId: "DL-1", reason: "admin_assigned" }));
    });

    it("a lead not Awaiting field visit is a plain owner swap", async () => {
        lead = { current_owner_id: "rep-1", lead_status: "Under_Discussion", pre_transfer_status: null };
        bookedVisits = [{ scheduled_date: "2026-10-13", asm_name: "Suresh" }];
        const out = await run();
        expect(out).toEqual({ handedBack: false, closedVisits: 0 });
        expect(statements.some((q) => /asm_id = NULL/.test(q))).toBe(false);
        expect(call()[0].statusChange).toBeUndefined();
        expect(call()[0]).toMatchObject({ fromOwnerId: "rep-1", toOwnerId: "rep-2" });
    });

    it("giving the lead to another ASM is not a hand-back", async () => {
        target = { id: "asm-2", is_active: true, role: "asm", name: "Kiran" };
        bookedVisits = [{ scheduled_date: "2026-10-13", asm_name: "Suresh" }];
        expect((await run()).handedBack).toBe(false);
    });

    it("rejects a missing or inactive target before touching the lead", async () => {
        target = undefined;
        await expect(run()).rejects.toMatchObject({ status: 404 });
        target = { id: "rep-2", is_active: false, role: "inside_sales_rep", name: "Ravi" };
        const err = await run().catch((e) => e);
        expect(err).toBeInstanceOf(EscalationTargetError);
        expect(err.status).toBe(400);
        expect(wrote()).toBe(false);
    });
});
