import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const dialect = new PgDialect();
const statements: string[] = [];
let lead: Record<string, unknown> | null = null;
let originator: { id: string; is_active: boolean | null } | null = null;

const tx = {
    execute: vi.fn(async (q: SQL) => {
        const text = dialect.sqlToQuery(q).sql;
        statements.push(text);
        if (/FROM dealer_leads/i.test(text)) return lead ? [lead] : [];
        if (/FROM users/i.test(text)) return originator ? [originator] : [];
        return [];
    }),
};
vi.mock("@/lib/db", () => ({ db: { transaction: (fn: (t: typeof tx) => unknown) => fn(tx) } }));
const writeTouchpoint = vi.fn(async () => ({ touchpointId: "tp", historyId: "h" }));
vi.mock("@/lib/touchpoints/write", () => ({ writeTouchpoint }));

const { reactivateLead } = await import("../reactivation");

const call = () => writeTouchpoint.mock.calls[0] as unknown as [Record<string, unknown>, { tx: unknown }];

beforeEach(() => {
    statements.length = 0;
    tx.execute.mockClear();
    writeTouchpoint.mockClear();
    lead = { lead_status: "Lost", lost_reason: "price_high", originator_id: "rep-1", current_owner_id: "rep-2" };
    originator = { id: "rep-1", is_active: true };
});

describe("reactivateLead", () => {
    it("routes the lead back to an active originator through the guarded writer", async () => {
        const out = await reactivateLead({ leadId: "DL-1", trigger: "admin", performedBy: "admin-1" });
        expect(out).toEqual({ new_status: "Assigned_Not_Contacted", new_owner_id: "rep-1" });

        const [input, opts] = call();
        expect(opts.tx).toBe(tx);
        expect(input).toMatchObject({
            dealerLeadId: "DL-1",
            touchpointType: "reactivated_via_admin",
            performedBy: "admin-1",
            syncMethod: "manual",
            fromOwnerId: "rep-2",
            toOwnerId: "rep-1",
            statusChange: {
                from: "Lost",
                to: "Assigned_Not_Contacted",
                fromLostReason: "price_high",
                event: "reactivation",
            },
        });
    });

    it("the raw UPDATE no longer writes the status — only owner routing and the prior reason", async () => {
        await reactivateLead({ leadId: "DL-1", trigger: "admin", performedBy: "admin-1" });
        const update = statements.find((s) => /UPDATE dealer_leads/i.test(s))!;
        expect(update).toMatch(/previous_lost_reason/);
        expect(update).toMatch(/current_owner_id/);
        expect(update).not.toMatch(/lead_status/);
        expect(statements.some((s) => /INSERT INTO/i.test(s))).toBe(false);
    });

    it("returns the lead to the pool when the originator is gone or inactive", async () => {
        originator = { id: "rep-1", is_active: false };
        const out = await reactivateLead({ leadId: "DL-1", trigger: "ai_dialer", performedBy: null });
        expect(out).toEqual({ new_status: "New_Unassigned", new_owner_id: null });
        expect(call()[0]).toMatchObject({
            touchpointType: "reactivated_via_ai_dialer",
            performedBy: null,
            syncMethod: "system",
            toOwnerId: null,
            statusChange: { to: "New_Unassigned", event: "reactivation" },
        });
    });

    it("refuses anything that is not Lost, and a missing lead, without writing", async () => {
        lead = { ...lead!, lead_status: "Under_Discussion" };
        await expect(reactivateLead({ leadId: "DL-1", trigger: "upload", performedBy: null })).rejects.toThrow(/Only a Lost lead/);
        lead = null;
        await expect(reactivateLead({ leadId: "DL-1", trigger: "upload", performedBy: null })).rejects.toThrow(/not found/);
        expect(writeTouchpoint).not.toHaveBeenCalled();
    });
});
