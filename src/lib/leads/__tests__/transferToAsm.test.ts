// ID 120 — Transfer to ASM locks the lead and refuses one already Awaiting
// field visit, so a second concurrent transfer can't overwrite
// pre_transfer_status with Transferred_to_ASM or book a second visit.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const dialect = new PgDialect();
const statements: string[] = [];
let leadRows: Record<string, unknown>[] = [];
const execute = vi.fn(async (q: SQL) => {
    statements.push(dialect.sqlToQuery(q).sql);
    return statements.length === 1 ? leadRows : [];
});
const values = vi.fn(async () => {});
const insert = vi.fn(() => ({ values }));
const tx = { execute, insert };
const transaction = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
vi.mock("@/lib/db", () => ({ db: { execute, transaction } }));
const writeTouchpoint = vi.fn(async () => ({ touchpointId: "tp", historyId: "h" }));
vi.mock("@/lib/touchpoints/write", () => ({ writeTouchpoint }));

const { transferLeadToAsm, LeadAlreadyTransferredError, TransferLeadNotFoundError } = await import("../transferToAsm");

const transfer = () =>
    transferLeadToAsm({ leadId: "DL-1", actorId: "isr-1", asmId: "asm-1", reason: "Commercials_Finalised", visitType: "Closing" });

beforeEach(() => {
    statements.length = 0;
    execute.mockClear();
    insert.mockClear();
    values.mockClear();
    writeTouchpoint.mockClear();
});

describe("transferLeadToAsm", () => {
    it("locks the lead row before reading its stage", async () => {
        leadRows = [{ lead_status: "Commercials_Finalised" }];
        await transfer();
        expect(statements[0]).toMatch(/FOR UPDATE/);
        expect(statements[1]).toMatch(/pre_transfer_status = lead_status/);
        expect(values).toHaveBeenCalledTimes(1);
        expect((writeTouchpoint.mock.calls[0] as unknown as [Record<string, unknown>])[0].statusChange).toEqual({
            from: "Commercials_Finalised",
            to: "Transferred_to_ASM",
            event: "transfer",
        });
    });

    it("refuses a lead already Awaiting field visit — no stamp, no second visit", async () => {
        leadRows = [{ lead_status: "Transferred_to_ASM" }];
        await expect(transfer()).rejects.toBeInstanceOf(LeadAlreadyTransferredError);
        expect(statements).toHaveLength(1);
        expect(insert).not.toHaveBeenCalled();
        expect(writeTouchpoint).not.toHaveBeenCalled();
    });

    it("404s a missing lead", async () => {
        leadRows = [];
        await expect(transfer()).rejects.toBeInstanceOf(TransferLeadNotFoundError);
    });
});
