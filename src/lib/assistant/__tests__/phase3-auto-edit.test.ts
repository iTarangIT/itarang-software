import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// Stage A: auto status/temperature on the cards, and the Edit flow.

const sqlText = (q: SQL) => new PgDialect().sqlToQuery(q).sql;
const rowsFor: { match: RegExp; rows: Record<string, unknown>[] }[] = [];
const executed: string[] = [];
const execute = vi.fn(async (q: SQL) => {
    const text = sqlText(q);
    executed.push(text);
    return rowsFor.find((r) => r.match.test(text))?.rows ?? [];
});
vi.mock("@/lib/db", () => ({ db: { execute } }));
const findLeadInScope = vi.fn();
vi.mock("../scope", async (orig) => ({ ...(await orig<typeof import("../scope")>()), findLeadInScope }));
const createPending = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ id: "act-1", expiresAt: new Date() }));
vi.mock("../actions", async (orig) => ({ ...(await orig<typeof import("../actions")>()), createPending }));
vi.mock("@/lib/inside-sales/logTouchpoint", () => ({ logLeadTouchpoint: vi.fn() }));
vi.mock("@/lib/leads/markLost", async (orig) => ({ ...(await orig<typeof import("@/lib/leads/markLost")>()), markLeadLost: vi.fn() }));
vi.mock("@/lib/leads/interestLevel", () => ({ setInterestLevel: vi.fn() }));

const { toolsFor } = await import("../registry");
const { beginEdit, withEditContext } = await import("../edit");
import type { AssistantUser, Preview, ToolContext } from "../types";

const ISR: AssistantUser = { id: "22222222-2222-4222-8222-222222222222", name: "Priya", role: "inside_sales_rep" };
const ASM: AssistantUser = { id: "33333333-3333-4333-8333-333333333333", name: "Rahul", role: "asm" };
const NOW = new Date("2026-09-24T12:00:00Z");
const ctx = (user: AssistantUser): ToolContext => ({ user, messageId: null, now: NOW, writesEnabled: true });
const lead = (over: Record<string, unknown> = {}) => ({
    id: "DL-1", shop_name: "ABC Traders", dealer_name: "Ramesh", current_owner_id: ISR.id, asm_id: ASM.id,
    lead_status: "Assigned_Not_Contacted", interest_level: null, next_follow_up_at: null,
    updated_at: new Date("2026-09-24T10:00:00Z"), owned: true, ...over,
});
const run = async (user: AssistantUser, name: string, input: Record<string, unknown>) => {
    const t = toolsFor(user.role, true).find((x) => x.name === name)!;
    return t.run(ctx(user), t.schema.parse(input));
};
const stored = () => createPending.mock.calls.at(-1)![0] as { plan: Record<string, unknown>; preview: Preview };

beforeEach(() => {
    vi.clearAllMocks();
    rowsFor.length = 0;
    executed.length = 0;
    findLeadInScope.mockResolvedValue(lead());
});

describe("auto status + temperature on the cards", () => {
    it("log_call 'Details Shared', rep said neither → Under Discussion + warm, both (auto)", async () => {
        await run(ISR, "log_call", { lead_id: "DL-1", channel: "call", connect_status: "connected", disposition: "Details Shared" });
        expect(stored().plan).toMatchObject({ status_to: "Under_Discussion", interest: "warm", auto: { status: true, interest: true } });
        expect(stored().preview.lines).toContainEqual({ label: "Status", value: "Assigned Not Contacted → Under Discussion (auto)" });
        expect(stored().preview.lines).toContainEqual({ label: "Temperature", value: "none → warm (auto)" });
    });

    it("what the rep said wins: an explicit temperature / 'no change' is kept", async () => {
        await run(ISR, "log_call", {
            lead_id: "DL-1", channel: "call", connect_status: "connected", disposition: "Details Shared", interest: "hot", status: "no_change",
        });
        expect(stored().plan).toMatchObject({ status_to: null, interest: "hot", auto: { status: false, interest: false } });
    });

    it("not connected → no auto change", async () => {
        await run(ISR, "log_call", { lead_id: "DL-1", channel: "call", connect_status: "not_connected", disposition: "Did not pick" });
        expect(stored().plan).toMatchObject({ status_to: null, interest: null });
    });

    it("log_visit productive on a transferred lead → Under Discussion (auto); dealer uninterested → cold (auto)", async () => {
        findLeadInScope.mockResolvedValue(lead({ current_owner_id: ASM.id, lead_status: "Transferred_to_ASM", interest_level: "warm" }));
        await run(ASM, "log_visit", { lead_id: "DL-1", visit_status: "visited", outcome: "productive", remarks: "met owner", next_action: "escalate" });
        expect(stored().plan).toMatchObject({ status_to: "Under_Discussion", auto: { status: true, interest: false } });
        await run(ASM, "log_visit", {
            lead_id: "DL-1", visit_status: "visited", outcome: "dealer_uninterested", remarks: "not keen", next_action: "escalate", status: "no_change",
        });
        expect(stored().plan).toMatchObject({ status_to: null, interest: "cold", auto: { interest: true } });
    });

    it("set_follow_up moves status only when the rep spoke to the dealer", async () => {
        await run(ISR, "set_follow_up", { lead_id: "DL-1", follow_up_at: "2026-09-25T11:00:00+05:30", note: "call again" });
        expect(stored().plan).toMatchObject({ status_to: null });
        await run(ISR, "set_follow_up", { lead_id: "DL-1", follow_up_at: "2026-09-25T11:00:00+05:30", note: "talked, call again", spoke_with_dealer: true });
        expect(stored().plan).toMatchObject({ status_to: "Under_Discussion" });
        expect(stored().preview).toMatchObject({ resets_idle_clock: true });
    });
});

describe("Edit", () => {
    const ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    const live = { tool: "set_follow_up", lead_id: "DL-1", input: { follow_up_at: "x" }, expires_at: new Date(Date.now() + 60_000), preview: { title: "Set follow-up — ABC", lines: [{ label: "Follow-up", value: "Fri 25 Sep, 11:00" }] } };

    it("a live card → remembered for the next message; nothing else is written", async () => {
        rowsFor.push({ match: /status = 'pending' AND step = 1/, rows: [live] });
        expect(await beginEdit(ID, ISR)).toEqual({ kind: "editing", title: "Set follow-up — ABC" });
        expect(executed.some((s) => /INSERT INTO assistant_conversations/.test(s) && /jsonb_set/.test(s))).toBe(true);
        expect(executed.some((s) => /UPDATE assistant_actions/.test(s))).toBe(false);
    });

    it("a card that is no longer live → why (e.g. replaced by a newer one)", async () => {
        rowsFor.push({ match: /SELECT status, user_id::text/, rows: [{ status: "cancelled", user_id: ISR.id, expired: false, error: "superseded by x" }] });
        expect(await beginEdit(ID, ISR)).toEqual({ kind: "superseded" });
    });

    it("the next message becomes a revision of that card; no edit pending → text unchanged", async () => {
        rowsFor.push({ match: /messages -> 'editing'/, rows: [{ editing: { action_id: ID, until: new Date(Date.now() + 60_000).toISOString() } }] });
        rowsFor.push({ match: /status = 'pending' AND step = 1/, rows: [live] });
        const text = await withEditContext(ISR, "parso 4 baje");
        expect(text).toMatch(/^\[EDIT\] .*"set_follow_up".*Follow-up: Fri 25 Sep, 11:00.*The user's change: parso 4 baje$/);
        expect(executed.some((s) => /messages - 'editing'/.test(s))).toBe(true); // consumed

        rowsFor.length = 0;
        expect(await withEditContext(ISR, "hello")).toBe("hello");
    });
});
