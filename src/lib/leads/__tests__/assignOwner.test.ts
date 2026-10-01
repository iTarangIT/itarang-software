import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const dialect = new PgDialect();
const statements: string[] = [];
const execute = vi.fn(async (q: SQL) => {
    statements.push(dialect.sqlToQuery(q).sql);
    return [{ from_owner_id: "rep-old" }];
});
vi.mock("@/lib/db", () => ({ db: { execute } }));
const writeTouchpoint = vi.fn(async () => ({ touchpointId: "tp", historyId: null }));
vi.mock("@/lib/touchpoints/write", () => ({ writeTouchpoint }));
const markSalesReady = vi.fn(async () => true);
vi.mock("@/lib/leads/salesReady", () => ({ markSalesReady }));

const { assignLeadOwner } = await import("../assignOwner");

const asm = { id: "asm-1", role: "asm" };
const assign = (fromStatus: string | null, target = asm) =>
    assignLeadOwner({
        leadId: "DL-1",
        fromStatus: fromStatus as never,
        target: target as never,
        actorId: "admin-1",
        actorRole: "admin",
        remarks: "reassign",
    });
const lastInput = () => (writeTouchpoint.mock.calls.at(-1) as unknown as [Record<string, unknown>])[0];

beforeEach(() => {
    statements.length = 0;
    execute.mockClear();
    writeTouchpoint.mockClear();
    markSalesReady.mockClear();
});

// Tracker ID 82: giving a lead an owner is a Sales-ready event (first one
// wins) — on every path, and only after the assignment itself is written.
describe("assignLeadOwner → Sales-ready", () => {
    it("every assignment path records the Sales-ready event, after the owner is written", async () => {
        for (const [status, target] of [
            ["Under_Discussion", asm],
            ["Transferred_to_ASM", asm],
            ["Won", asm],
            [null, { id: "isr-1", role: "inside_sales_rep" }],
            ["Under_Discussion", { id: "isr-1", role: "inside_sales_rep" }],
        ] as const) {
            markSalesReady.mockClear();
            writeTouchpoint.mockClear();
            const out = await assign(status, target as never);
            expect(out.assigned, `${status} → ${target.role}`).toBe(true);
            expect(markSalesReady).toHaveBeenCalledTimes(1);
            expect(markSalesReady).toHaveBeenCalledWith(expect.anything(), { leadId: "DL-1", reason: "admin_assigned", actorId: "admin-1" });
            expect(writeTouchpoint.mock.invocationCallOrder[0]).toBeLessThan(markSalesReady.mock.invocationCallOrder[0]!);
        }
    });
});

describe("assignLeadOwner → ASM", () => {
    it("lifts an open lead onto the ASM's queue (Transferred to ASM)", async () => {
        const out = await assign("Under_Discussion");
        expect(out).toEqual({ assigned: true, path: "asm_lift", statusLiftedTo: "Transferred_to_ASM" });
        expect(statements[0]).toMatch(/pre_transfer_status = dl\.lead_status/);
        expect(lastInput()).toMatchObject({
            touchpointType: "asm_transfer",
            fromOwnerId: "rep-old",
            toOwnerId: "asm-1",
            statusChange: { from: "Under_Discussion", to: "Transferred_to_ASM", event: "transfer" },
        });
    });

    it("lifts a lead that is not in the pipeline yet (NULL status)", async () => {
        expect((await assign(null)).path).toBe("asm_lift");
    });

    // ID 74: Won is open, but the S3 guard refuses a transfer from it. The owner
    // swap commits on its own, so asking for the move used to leave the new
    // owner in place and then fail with a 409 and no touchpoint.
    it("a Won lead changes hands with NO status move and no transfer stamps", async () => {
        const out = await assign("Won");
        expect(out).toEqual({ assigned: true, path: "owner_swap", statusLiftedTo: null });
        expect(statements).toHaveLength(1);
        expect(statements[0]).not.toMatch(/pre_transfer_status|asm_id/);
        expect(writeTouchpoint).toHaveBeenCalledTimes(1);
        expect(lastInput().statusChange).toBeUndefined();
        expect(lastInput()).toMatchObject({ fromOwnerId: "rep-old", toOwnerId: "asm-1" });
    });

    it("a closed lead also takes the plain swap", async () => {
        for (const status of ["Converted", "Lost"]) {
            writeTouchpoint.mockClear();
            expect((await assign(status)).path, status).toBe("owner_swap");
            expect(lastInput().statusChange).toBeUndefined();
        }
    });

    it("a lead already with an ASM only swaps which ASM holds it", async () => {
        expect((await assign("Transferred_to_ASM")).path).toBe("asm_swap");
        expect(lastInput().statusChange).toBeUndefined();
    });
});
