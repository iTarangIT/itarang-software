import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// ID 253 (13 Nov): log_call on a lead that had a NeoDove call in the last 30 minutes asks
// first, and "add_note" puts the remarks on that call instead of logging a second one.

const dialect = new PgDialect();
let neodoveRows: Array<Record<string, unknown>> = [];
const executed: string[] = [];
const execute = vi.fn(async (q: unknown) => {
    const { sql: text } = dialect.sqlToQuery(q as SQL);
    executed.push(text);
    if (text.includes("external_system = 'neodove'") && text.includes("SELECT")) return neodoveRows;
    if (text.includes("UPDATE lead_touchpoints")) return [{ id: "11111111-2222-4333-8444-555555555555" }];
    return [];
});
vi.mock("@/lib/db", () => {
    const chain = { from: () => chain, where: () => chain, limit: async () => [] };
    return { db: { select: () => chain, execute } };
});
const findLeadInScope = vi.fn();
vi.mock("../scope", async (orig) => ({ ...(await orig<typeof import("../scope")>()), findLeadInScope }));
const createPending = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ id: "act-1", expiresAt: new Date() }));
vi.mock("../actions", async (orig) => ({ ...(await orig<typeof import("../actions")>()), createPending }));
const logLeadTouchpoint = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ touchpointId: "tp-1", historyId: null }));
vi.mock("@/lib/inside-sales/logTouchpoint", async (orig) => ({ ...(await orig<typeof import("@/lib/inside-sales/logTouchpoint")>()), logLeadTouchpoint }));
const setInterestLevel = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ changed: true }));
vi.mock("@/lib/leads/interestLevel", () => ({ setInterestLevel }));

const { toolsFor } = await import("../registry");
const { APPLIERS } = await import("../appliers");
const { neodoveGuardQuestion } = await import("../tools/write/logCall");
import type { AssistantUser, ToolContext } from "../types";

const ISR: AssistantUser = { id: "isr-1", name: "Priya", role: "inside_sales_rep" };
// 13 Nov 2026, 4:30 pm IST.
const NOW = new Date("2026-11-13T11:00:00Z");
const TEN_MIN_AGO = new Date(NOW.getTime() - 10 * 60_000);
const ctx: ToolContext = { user: ISR, messageId: "11111111-1111-4111-8111-111111111111", now: NOW, writesEnabled: true };
const lead = {
    id: "L-b8ZKDM7f", shop_name: "Zam Zam E Rikshaw Spare Parts", dealer_name: "Zam Zam", current_owner_id: "isr-1", asm_id: null,
    lead_status: "Under_Discussion", interest_level: "warm", next_follow_up_at: null,
    updated_at: new Date("2026-11-13T09:00:00Z"), owned: true,
};
const run = async (input: Record<string, unknown>) => {
    const t = toolsFor("inside_sales_rep", true).find((x) => x.name === "log_call")!;
    return t.run(ctx, t.schema.parse(input));
};
const CALL = { lead_id: "L-b8ZKDM7f", channel: "call", connect_status: "connected", disposition: "Details Shared", remarks: "payment on 15th" };

beforeEach(() => {
    vi.clearAllMocks();
    executed.length = 0;
    neodoveRows = [];
    findLeadInScope.mockResolvedValue(lead);
});

describe("ID 253: log_call NeoDove guard", () => {
    it("no NeoDove call in the last 30 minutes: logs as before", async () => {
        const r = await run(CALL);
        expect(r.kind).toBe("preview");
        expect(executed.some((s) => s.includes("external_system = 'neodove'"))).toBe(true);
    });

    it("a NeoDove call 10 minutes ago: asks first and creates nothing", async () => {
        neodoveRows = [{ touchpoint_id: "11111111-2222-4333-8444-555555555555", performed_at: TEN_MIN_AGO.toISOString(), disposition: "Interested", connect_status: "connected" }];
        const r = await run(CALL);
        expect(r).toEqual({ kind: "question", question: expect.stringMatching(/NeoDove call at 4:20 pm \(connected · Interested\).*add your note to that call/) });
        expect(createPending).not.toHaveBeenCalled();
    });

    it("add_note: a preview that adds to that call; applying appends the note, no new touchpoint", async () => {
        neodoveRows = [{ touchpoint_id: "11111111-2222-4333-8444-555555555555", performed_at: TEN_MIN_AGO.toISOString(), disposition: "Interested", connect_status: "connected" }];
        const r = await run({ lead_id: "L-b8ZKDM7f", channel: "call", remarks: "payment on 15th", interest: "hot", neodove_call: "add_note" });
        expect(r.kind).toBe("preview");
        const pending = createPending.mock.calls.at(-1)![0] as { plan: Record<string, unknown> };
        expect(pending.plan).toMatchObject({ attach_to_touchpoint_id: "11111111-2222-4333-8444-555555555555", disposition: null, status_to: null, interest: "hot" });

        const tx = { execute } as never;
        const out = await APPLIERS.log_call.apply({ tx, user: ISR, step: 1, actionId: "act-1" } as never, pending.plan as never);
        expect(out).toMatchObject({ added_to_neodove_call: true });
        expect(logLeadTouchpoint).not.toHaveBeenCalled();
        expect(executed.some((s) => s.includes("UPDATE lead_touchpoints"))).toBe(true);
        expect(setInterestLevel).toHaveBeenCalledTimes(1);
    });

    it("separate: logs a second call as asked", async () => {
        neodoveRows = [{ touchpoint_id: "11111111-2222-4333-8444-555555555555", performed_at: TEN_MIN_AGO.toISOString(), disposition: null, connect_status: null }];
        const r = await run({ ...CALL, neodove_call: "separate" });
        expect(r.kind).toBe("preview");
        const pending = createPending.mock.calls.at(-1)![0] as { plan: Record<string, unknown> };
        expect(pending.plan.attach_to_touchpoint_id ?? null).toBeNull();
    });

    it("add_note with a status change: asks to log separately instead", async () => {
        neodoveRows = [{ touchpoint_id: "11111111-2222-4333-8444-555555555555", performed_at: TEN_MIN_AGO.toISOString(), disposition: null, connect_status: null }];
        const r = await run({ lead_id: "L-b8ZKDM7f", channel: "call", remarks: "x", status: "Lost", lost_reason: "price_high", neodove_call: "add_note" });
        expect(r.kind).toBe("question");
        expect(createPending).not.toHaveBeenCalled();
    });

    it("the question reads plainly when NeoDove sent no outcome", () => {
        expect(neodoveGuardQuestion({ touchpoint_id: "x", performed_at: TEN_MIN_AGO, disposition: null, connect_status: null })).toMatch(
            /^This lead had a NeoDove call at 4:20 pm\. Should I add/,
        );
    });
});

describe("ID 253: My dealers name match ignores spaces, dots and hyphens", async () => {
    const { matchesAccountQuery } = await import("../tools/accounts");
    const zam = { dealer: "Zam Zam E Rikshaw Spare Parts", city: "Patna" };
    it("Zamzam, Zam-Zam and zam.zam find Zam Zam", () => {
        for (const q of ["Zamzam", "Zam-Zam", "zam.zam", "Zam Zam"]) expect(matchesAccountQuery(zam, q)).toBe(true);
    });
    it("still needs the letters to match", () => {
        expect(matchesAccountQuery(zam, "Zamzar")).toBe(false);
        expect(matchesAccountQuery(zam, "Patna")).toBe(true);
    });
});
