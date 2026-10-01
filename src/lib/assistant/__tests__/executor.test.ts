import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { z } from "zod";

// A fake db: the claim UPDATE returns the stored action; inside the transaction
// the "mark confirmed" UPDATE returns its id and everything else returns [].
const sqlText = (q: SQL) => new PgDialect().sqlToQuery(q).sql;
const txSql: string[] = [];
const state = { committed: false, action: null as Record<string, unknown> | null };
const tx = {
    execute: vi.fn(async (q: SQL) => {
        const text = sqlText(q);
        txSql.push(text);
        return /status = 'confirmed'/.test(text) ? [{ id: state.action!.id }] : [];
    }),
};
const execute = vi.fn(async (q: SQL) => {
    const text = sqlText(q);
    if (/SET status = 'executing'/.test(text)) return state.action ? [state.action] : [];
    return [];
});
const transaction = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
    const out = await fn(tx);
    state.committed = true;
    return out;
});
vi.mock("@/lib/db", () => ({ db: { execute, transaction } }));
vi.mock("../config", async (orig) => ({ ...(await orig<typeof import("../config")>()), writesEnabledFor: () => true }));

const apply = vi.fn();
vi.mock("../appliers", async () => {
    const { defineApplier } = await import("../applierSpec");
    return {
        APPLIERS: {
            create_lead: defineApplier({ schema: z.object({ n: z.number() }), ownership: "none", apply }),
        },
    };
});

const { executeAction } = await import("../executor");

const USER = { id: "22222222-2222-4222-8222-222222222222", name: "Priya", role: "inside_sales_rep" as const };
const ACTION_ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

beforeEach(() => {
    vi.clearAllMocks();
    txSql.length = 0;
    state.committed = false;
    state.action = {
        id: ACTION_ID,
        user_id: USER.id,
        tool: "create_lead",
        lead_id: null,
        lead_version: null,
        input: { n: 1 },
        preview: { title: "Create lead — ABC", lines: [], resets_idle_clock: false, warning: null, needs_second_confirm: false, crm_url: "https://crm/leads" },
        status: "executing",
        step: 1,
        expires_at: new Date(Date.now() + 60_000),
    };
});

describe("executor — lead-less actions (ownership: none)", () => {
    it("never locks or ownership-checks a lead, and records the lead the applier created", async () => {
        apply.mockResolvedValue({ lead_id: "DL-new", crm_url: "https://crm/lead/DL-new" });
        const out = await executeAction(ACTION_ID, USER, { messageId: null });
        expect(out).toMatchObject({ kind: "confirmed", tool: "create_lead", leadId: "DL-new", crmUrl: "https://crm/lead/DL-new" });
        expect(txSql.some((s) => /FOR UPDATE/.test(s))).toBe(false);
        expect(txSql.find((s) => /status = 'confirmed'/.test(s))).toMatch(/lead_id = COALESCE\(lead_id,/);
    });
});

describe("executor — afterCommit", () => {
    it("runs only after the transaction committed, and its result comes back as extra", async () => {
        let committedWhenRun: boolean | null = null;
        apply.mockResolvedValue({
            lead_id: "DL-new",
            afterCommit: async () => {
                committedWhenRun = state.committed;
                return { delivered: true };
            },
        });
        const out = await executeAction(ACTION_ID, USER, { messageId: null });
        expect(committedWhenRun).toBe(true);
        expect(out).toMatchObject({ kind: "confirmed", extra: { delivered: true } });
        // The function itself is never stored in the audit's `after`.
        expect(txSql.find((s) => /status = 'confirmed'/.test(s))).not.toMatch(/afterCommit/);
    });

    it("a throwing afterCommit leaves the outcome confirmed", async () => {
        const err = vi.spyOn(console, "error").mockImplementation(() => {});
        apply.mockResolvedValue({ lead_id: "DL-new", afterCommit: async () => { throw new Error("send failed"); } });
        const out = await executeAction(ACTION_ID, USER, { messageId: null });
        expect(out).toMatchObject({ kind: "confirmed", extra: null });
        expect(err).toHaveBeenCalled();
        err.mockRestore();
    });

    it("a failed apply ends as an error and the transaction never commits", async () => {
        apply.mockImplementation(async () => {
            throw new Error("boom");
        });
        const out = await executeAction(ACTION_ID, USER, { messageId: null });
        expect(out).toEqual({ kind: "error", message: "boom" });
        expect(state.committed).toBe(false);
    });
});
