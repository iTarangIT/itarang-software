import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

vi.mock("@/lib/db", () => ({ db: {} }));
const writeTouchpoint = vi.fn(async () => ({ touchpointId: "tp", historyId: "h" }));
vi.mock("@/lib/touchpoints/write", () => ({ writeTouchpoint }));

const { claimLead } = await import("../claimLead");

const dialect = new PgDialect();

/** A fake tx: the SELECT returns `lead`, the guarded UPDATE returns `updated` rows. */
function fakeTx(lead: { lead_status: string | null; current_owner_id: string | null } | null, updated = 1) {
    const statements: string[] = [];
    const tx = {
        execute: vi.fn(async (q: SQL) => {
            const text = dialect.sqlToQuery(q).sql;
            statements.push(text);
            if (/^\s*SELECT/i.test(text)) return lead ? [lead] : [];
            return Array.from({ length: updated }, () => ({ id: "DL-1" }));
        }),
    };
    return { tx, statements };
}

beforeEach(() => writeTouchpoint.mockClear());

describe("claimLead", () => {
    it("an ASM claim makes them the field ASM (Today's Schedule keys on asm_id)", async () => {
        const { tx, statements } = fakeTx({ lead_status: null, current_owner_id: null });
        const out = await claimLead("DL-1", "asm-1", { tx: tx as never, actorRole: "asm" });
        expect(out).toEqual({ ok: true });
        expect(statements[1]).toMatch(/asm_id = \$\d+/);
    });

    it("an ISR claim leaves asm_id alone", async () => {
        const { tx, statements } = fakeTx({ lead_status: "New_Unassigned", current_owner_id: null });
        await claimLead("DL-1", "isr-1", { tx: tx as never, actorRole: "inside_sales_rep" });
        expect(statements[1]).not.toMatch(/asm_id/);
    });

    it("writes the touchpoint on the SAME transaction", async () => {
        const { tx } = fakeTx({ lead_status: null, current_owner_id: null });
        await claimLead("DL-1", "isr-1", { tx: tx as never });
        expect(writeTouchpoint).toHaveBeenCalledTimes(1);
        const [input, opts] = writeTouchpoint.mock.calls[0] as unknown as [Record<string, unknown>, { tx: unknown }];
        expect(opts.tx).toBe(tx);
        expect(input).toMatchObject({
            touchpointType: "lead_claimed",
            fromOwnerId: null,
            toOwnerId: "isr-1",
            statusChange: { from: "New_Unassigned", to: "Assigned_Not_Contacted" },
        });
    });

    it("refuses owned, terminal, missing and lost-the-race leads without writing", async () => {
        const cases: [Parameters<typeof fakeTx>, string][] = [
            [[{ lead_status: "Under_Discussion", current_owner_id: "someone" }], "already_owned"],
            [[{ lead_status: "Lost", current_owner_id: null }], "terminal"],
            [[null], "not_found"],
            [[{ lead_status: null, current_owner_id: null }, 0], "already_owned"],
        ];
        for (const [args, reason] of cases) {
            const { tx } = fakeTx(...args);
            expect(await claimLead("DL-1", "isr-1", { tx: tx as never })).toEqual({ ok: false, reason });
        }
        expect(writeTouchpoint).not.toHaveBeenCalled();
    });
});
