// ID 77.5 — an ISR / partner taking a lead that is Awaiting field visit
// (Transferred_to_ASM) gets it back at its pre-transfer stage, in one tx.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const dialect = new PgDialect();
const statements: string[] = [];
let row: Record<string, unknown> = {};
const execute = vi.fn(async (q: SQL) => {
    statements.push(dialect.sqlToQuery(q).sql);
    return [row];
});
const tx = { execute };
const transaction = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
vi.mock("@/lib/db", () => ({ db: { execute, transaction } }));
const writeTouchpoint = vi.fn(async () => ({ touchpointId: "tp", historyId: "h" }));
vi.mock("@/lib/touchpoints/write", () => ({ writeTouchpoint }));
// ID 82: assignLeadOwner marks the lead sales-ready after the assignment; that
// write has its own tests and must not count against the transaction asserts.
const markSalesReady = vi.fn(async () => true);
vi.mock("@/lib/leads/salesReady", () => ({ markSalesReady }));

const { assignLeadOwner, statusBeforeTransfer } = await import("../assignOwner");

const rep = { id: "rep-2", name: "Ravi", role: "inside_sales_rep" };
const assign = (target: Record<string, unknown> = rep) =>
    assignLeadOwner({
        leadId: "DL-1",
        fromStatus: "Transferred_to_ASM",
        target: target as never,
        actorId: "admin-1",
        actorRole: "admin",
        remarks: "reassign",
    });
const call = () => writeTouchpoint.mock.calls.at(-1) as unknown as [Record<string, unknown>, Record<string, unknown>];

beforeEach(() => {
    statements.length = 0;
    execute.mockClear();
    transaction.mockClear();
    writeTouchpoint.mockClear();
});

describe("statusBeforeTransfer", () => {
    it("restores an open working stage", () => {
        expect(statusBeforeTransfer("Commercials_Finalised")).toBe("Commercials_Finalised");
        expect(statusBeforeTransfer("Under_Discussion")).toBe("Under_Discussion");
    });
    it("falls back to Assigned for null / legacy / non-working values", () => {
        for (const v of [null, "", "new", "New_Unassigned", "Transferred_to_ASM", "Won", "Lost", "Converted"]) {
            expect(statusBeforeTransfer(v), String(v)).toBe("Assigned_Not_Contacted");
        }
    });
});

describe("assignLeadOwner → ISR on a Transferred_to_ASM lead", () => {
    it("restores pre_transfer_status via a correction inside one tx", async () => {
        row = { from_owner_id: "asm-1", pre_transfer_status: "Commercials_Explained", lead_status: "Transferred_to_ASM" };
        const out = await assign();
        expect(out).toEqual({ assigned: true, path: "transfer_undo", statusLiftedTo: "Commercials_Explained" });
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(statements).toHaveLength(1);
        expect(statements[0]).toMatch(/pre_transfer_status = CASE/);
        const [input, opts] = call();
        expect(opts).toEqual({ tx });
        expect(input).toMatchObject({
            fromOwnerId: "asm-1",
            toOwnerId: "rep-2",
            countsAsWork: false,
            statusChange: { from: "Transferred_to_ASM", to: "Commercials_Explained", event: "correction" },
        });
        expect((input.statusChange as { reasonNotes: string }).reasonNotes).toMatch(/Ravi/);
    });

    it("falls back to Assigned_Not_Contacted for a partner when nothing was stamped", async () => {
        row = { from_owner_id: "asm-1", pre_transfer_status: null, lead_status: "Transferred_to_ASM" };
        const out = await assign({ id: "p-1", name: null, role: "partner" });
        expect(out.statusLiftedTo).toBe("Assigned_Not_Contacted");
    });

    it("records only the hop when the lead moved on before the lock", async () => {
        row = { from_owner_id: "asm-1", pre_transfer_status: null, lead_status: "Under_Discussion" };
        const out = await assign();
        expect(out).toEqual({ assigned: true, path: "owner_swap", statusLiftedTo: null });
        expect(call()[0].statusChange).toBeUndefined();
    });

    it("an ASM target still only swaps which ASM holds it", async () => {
        row = { from_owner_id: "asm-1" };
        expect((await assign({ id: "asm-2", name: null, role: "asm" })).path).toBe("asm_swap");
        expect(transaction).not.toHaveBeenCalled();
    });
});
