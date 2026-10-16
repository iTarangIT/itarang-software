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
            create_lead: defineApplier({
                schema: z.object({ n: z.number() }),
                ownership: "none",
                apply,
                // Exercised by the send tests below (the real one is send_quote's / the invite's).
                sendFailed: (extra) => extra?.delivered === false,
            }),
        },
    };
});

const { executeAction, classifyUnclaimable } = await import("../executor");
const { StatusGuardError } = await import("@/lib/touchpoints/write");
const { WithdrawQuoteError } = await import("@/lib/leads/withdrawQuote");
const { ReassignError } = await import("@/lib/leads/reassign");
const { EscalateError } = await import("@/lib/leads/escalate");
const { CampaignError } = await import("@/lib/leads/acquisitionCampaigns");
const { AlreadyWonGstinChangeError } = await import("@/lib/leads/markConverted");
const { renderTapOutcome } = await import("@/lib/wa-assistant/render");

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

describe("executor — a CRM writer's refusal is the reply (Phase C1)", () => {
    class CommercialInputError extends Error {
        readonly status = 409;
    }
    const cases: [string, Error][] = [
        ["StatusGuardError", new StatusGuardError("A Lost lead cannot be transferred.")],
        ["WithdrawQuoteError", new WithdrawQuoteError("The dealer has approved this quote, so it cannot be withdrawn.")],
        ["CommercialInputError", new CommercialInputError("The deal card is locked.")],
        ["AlreadyWonGstinChangeError", new AlreadyWonGstinChangeError()],
        ["ReassignError", new ReassignError("self", "Cannot reassign to yourself.", 400)],
        ["EscalateError", new EscalateError("not_open", "Only an open lead can be escalated.", 400)],
        ["CampaignError", new CampaignError("That campaign is closed.")],
    ];
    for (const [name, err] of cases) {
        it(`${name} → rejected "refused" with the writer's sentence; the reply says it and that nothing was saved`, async () => {
            apply.mockRejectedValueOnce(err);
            const out = await executeAction(ACTION_ID, USER, { messageId: null });
            expect(out).toEqual({ kind: "rejected", reason: "refused", message: err.message });
            expect(state.committed).toBe(false);
            const body = renderTapOutcome(out).body;
            expect(body.startsWith(err.message.replace(/\.$/, ""))).toBe(true);
            expect(body).toMatch(/Nothing was saved\.$/);
        });
    }

    it("a real crash (no 4xx status) is still the generic error", async () => {
        apply.mockRejectedValueOnce(Object.assign(new Error("connection reset"), { status: 500 }));
        const out = await executeAction(ACTION_ID, USER, { messageId: null });
        expect(out).toEqual({ kind: "error", message: "connection reset" });
        expect(renderTapOutcome(out).body).toMatch(/Something went wrong/);
    });
});

describe("executor — a confirmed send that delivered nothing (Phase C5)", () => {
    it("is noted on the confirmed action; a repeat tap then says to ask again, not 'Already saved.'", async () => {
        apply.mockResolvedValue({ afterCommit: async () => ({ delivered: false, error: "not on WhatsApp" }) });
        const out = await executeAction(ACTION_ID, USER, { messageId: null });
        expect(out).toMatchObject({ kind: "confirmed", extra: { delivered: false } });
        const note = execute.mock.calls.map((c) => sqlText(c[0])).find((t) => /SET error =/.test(t) && /status = 'confirmed'/.test(t));
        expect(note).toBeDefined();

        execute.mockResolvedValueOnce([{ status: "confirmed", user_id: USER.id, expired: false, error: "send_failed: not on WhatsApp" }] as never);
        const again = await classifyUnclaimable(ACTION_ID, USER.id);
        expect(again).toEqual({ kind: "send_failed" });
        expect(renderTapOutcome(again).body).toMatch(/Ask me again for a new card/);
        execute.mockResolvedValueOnce([{ status: "confirmed", user_id: USER.id, expired: false, error: null }] as never);
        expect(await classifyUnclaimable(ACTION_ID, USER.id)).toEqual({ kind: "already_done" });
    });

    it("a delivered send is not noted", async () => {
        apply.mockResolvedValue({ afterCommit: async () => ({ delivered: true }) });
        await executeAction(ACTION_ID, USER, { messageId: null });
        expect(execute.mock.calls.map((c) => sqlText(c[0])).some((t) => /SET error =/.test(t) && /status = 'confirmed'/.test(t))).toBe(false);
    });
});
