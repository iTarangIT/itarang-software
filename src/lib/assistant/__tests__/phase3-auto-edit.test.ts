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

    // ID 80: the card shows what the writer will do. A temperature the rep
    // stated wins; a status cannot be held back with "no change" — the
    // connected call is first contact.
    it("an explicit temperature is kept; 'no change' does not hold the status the call earned", async () => {
        await run(ISR, "log_call", {
            lead_id: "DL-1", channel: "call", connect_status: "connected", disposition: "Details Shared", interest: "hot", status: "no_change",
        });
        expect(stored().plan).toMatchObject({ status_to: "Under_Discussion", interest: "hot", auto: { status: true, interest: false } });
        expect(stored().preview.lines).toContainEqual({ label: "Status", value: "Assigned Not Contacted → Under Discussion (auto)" });
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
        // The temperature follows the outcome (cold). The status still moves:
        // a done visit ends Awaiting field visit whatever the outcome (ID 77),
        // and "no change" cannot hold it (ID 80) — so the card says so.
        expect(stored().plan).toMatchObject({ status_to: "Under_Discussion", interest: "cold", auto: { status: true, interest: true } });
    });

    // Tracker ID 80 gap: the card must say what saving will do. Any DONE visit
    // ends Awaiting field visit (ID 77) — even one where the dealer was not
    // there — and the lead goes back to its pre-transfer stage when further.
    it("log_visit on a lead Awaiting field visit: the card shows the status the visit ends in, whatever the outcome", async () => {
        const awaiting = lead({ current_owner_id: ASM.id, lead_status: "Transferred_to_ASM", interest_level: "warm" });
        findLeadInScope.mockResolvedValue(awaiting);
        const visit = { lead_id: "DL-1", visit_status: "visited", outcome: "dealer_not_present", remarks: "shop shut", next_action: "escalate" };

        // No pre-transfer stage on record → first contact.
        await run(ASM, "log_visit", visit);
        expect(stored().plan).toMatchObject({ status_to: "Under_Discussion", auto: { status: true } });
        expect(stored().preview.lines).toContainEqual({ label: "Status", value: "Awaiting field visit → Under Discussion (auto)" });

        // Transferred at Commercials finalised → restored, not dropped back.
        rowsFor.push({ match: /SELECT pre_transfer_status FROM dealer_leads/, rows: [{ pre_transfer_status: "Commercials_Finalised" }] });
        await run(ASM, "log_visit", { ...visit, status: "no_change" });
        expect(stored().plan).toMatchObject({ status_to: "Commercials_Finalised", auto: { status: true } });

        // A visit that did not happen ends nothing.
        await run(ASM, "log_visit", { lead_id: "DL-1", visit_status: "postponed", remarks: "dealer away", next_action: "next_visit", next_visit_date: "2026-09-29" });
        expect(stored().plan).toMatchObject({ status_to: null });

        // Any other lead: a quiet visit moves nothing, and the pre-transfer stage is not even read.
        executed.length = 0;
        findLeadInScope.mockResolvedValue(lead({ current_owner_id: ASM.id, lead_status: "Under_Discussion" }));
        await run(ASM, "log_visit", visit);
        expect(stored().plan).toMatchObject({ status_to: null });
        expect(executed.some((s) => /pre_transfer_status/.test(s))).toBe(false);
    });

    // Tracker ID 80, review 30 Sep point 2: a follow-up is a note and a date.
    it("set_follow_up never moves the status — not even when the rep says they spoke to the dealer", async () => {
        await run(ISR, "set_follow_up", { lead_id: "DL-1", follow_up_at: "2026-09-25T11:00:00+05:30", note: "call again" });
        expect(stored().plan).not.toHaveProperty("status_to");
        expect(stored().preview).toMatchObject({ resets_idle_clock: false });
        // A model that still sends the old flag changes nothing.
        await run(ISR, "set_follow_up", { lead_id: "DL-1", follow_up_at: "2026-09-25T11:00:00+05:30", note: "talked, call again", spoke_with_dealer: true });
        expect(stored().plan).not.toHaveProperty("status_to");
        expect(stored().preview).toMatchObject({ resets_idle_clock: false });
        expect(JSON.stringify(stored().preview)).not.toMatch(/Status/);
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
