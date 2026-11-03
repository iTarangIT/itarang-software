import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// ID 211 — the WhatsApp assistant's dealer-account tools: my_dealers,
// get_account_details, account_visit_link, create_account_quote. The real
// scope code runs (myDealerRows, accountQuoteAccess); only the database, the
// health list, the team lookup and the writers are mocked. The point: WhatsApp
// never offers or acts on an account the person may not see.

type Acct = { id: string; name: string; owner_id: string | null; owner_name: string | null };
const ACCOUNTS: Record<string, Acct> = {
    A1: { id: "A1", name: "Shree Batteries", owner_id: "isr-1", owner_name: "Priya" },
    A2: { id: "A2", name: "Team Traders", owner_id: "isr-2", owner_name: "Kapil" },
    A3: { id: "A3", name: "Other Owner Co", owner_id: "isr-9", owner_name: "Someone" },
    A4: { id: "A4", name: "Rahul's Own", owner_id: "asm-1", owner_name: "Rahul" },
    A5: { id: "A5", name: "Nobody's Dealer", owner_id: null, owner_name: null },
};

const dialect = new PgDialect();
const execute = vi.fn(async (q: unknown) => {
    const { sql: text, params } = dialect.sqlToQuery(q as SQL);
    if (text.includes("to_regclass")) return [{ ok: true }];
    if (text.includes("FROM accounts a")) {
        const a = ACCOUNTS[String(params[0])];
        return a ? [{ ...a, gstin: null, city: "Patna", state: "Bihar", contact_name: null, contact_email: null, contact_phone: null }] : [];
    }
    return [];
});
vi.mock("@/lib/db", () => ({ db: { execute } }));
vi.mock("@/lib/accounts/tables", async (orig) => ({
    ...(await orig<typeof import("@/lib/accounts/tables")>()),
    hasAccountOwnershipTables: async () => true,
}));
const team: Record<string, string[]> = { "asm-1": ["isr-2"], "isr-1": ["someone-under-isr"] };
vi.mock("@/lib/users/team", () => ({ getTeamMemberIds: async (id: string) => team[id] ?? [] }));
vi.mock("@/lib/dealers/accountHealth", () => ({
    listDealerHealth: async () =>
        Object.values(ACCOUNTS).map((a) => ({
            account_id: a.id,
            dealer: a.name,
            city: "Patna",
            owner_id: a.owner_id,
            owner_name: a.owner_name,
            last_order: "2026-10-20",
            days_since_last_order: 14,
            bucket: "active",
        })),
}));
const listAccountQuotations = vi.fn(async () => [
    {
        version_no: 1,
        quote_number: "AQ-1",
        total: "120000",
        price_quoted: "120000",
        approval_status: "approved",
        rejection_reason: null,
        dealer_decision: null,
        oem_evaluation: { lines: [{ oem_price: 99999 }] },
        created_at: "2026-10-30T05:00:00Z",
    },
]);
vi.mock("@/lib/accounts/quotations/store", () => ({ listAccountQuotations }));
const createPending = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ id: "act-1", expiresAt: new Date() }));
vi.mock("../actions", async (orig) => ({ ...(await orig<typeof import("../actions")>()), createPending }));
const createAccountQuotation = vi.fn();
vi.mock("@/lib/accounts/quotations/create", () => ({ createAccountQuotation }));

const { toolsFor } = await import("../registry");
const { APPLIERS } = await import("../appliers");
import type { AssistantUser, ToolContext } from "../types";

const ISR: AssistantUser = { id: "isr-1", name: "Priya", role: "inside_sales_rep" };
const ASM: AssistantUser = { id: "asm-1", name: "Rahul", role: "asm" };
const ctx = (user: AssistantUser): ToolContext => ({ user, messageId: null, now: new Date("2026-11-03T06:00:00Z"), writesEnabled: true });
const run = async (user: AssistantUser, name: string, input: Record<string, unknown>) => {
    const t = toolsFor(user.role, true).find((x) => x.name === name)!;
    return t.run(ctx(user), t.schema.parse(input));
};
const ids = (r: unknown) => (r as { rows: { id: string }[] }).rows.map((x) => x.id).sort();

beforeEach(() => {
    createPending.mockClear();
    createAccountQuotation.mockReset();
});

describe("my_dealers (ID 211)", () => {
    it("an ISR sees only their own accounts, even with people under them", async () => {
        expect(ids(await run(ISR, "my_dealers", {}))).toEqual(["A1"]);
    });

    it("an ASM sees their own and their direct reports' accounts, nobody else's", async () => {
        expect(ids(await run(ASM, "my_dealers", {}))).toEqual(["A2", "A4"]);
    });

    it("finds by name, inside the scope only", async () => {
        expect(ids(await run(ASM, "my_dealers", { query: "team" }))).toEqual(["A2"]);
        expect(ids(await run(ASM, "my_dealers", { query: "other owner" }))).toEqual([]);
    });
});

describe("an account outside the scope is not found (ID 211 #4)", () => {
    for (const [who, user, foreign] of [
        ["ISR", ISR, ["A2", "A3", "A5"]],
        ["ASM", ASM, ["A1", "A3", "A5"]],
    ] as const) {
        it(`${who}: details, visit link and quote all refuse`, async () => {
            for (const id of foreign) {
                expect(await run(user, "get_account_details", { account_id: id })).toEqual({ kind: "not_found" });
                expect(await run(user, "account_visit_link", { account_id: id })).toEqual({ kind: "not_found" });
                expect(
                    await run(user, "create_account_quote", {
                        account_id: id,
                        lines: [{ product_id: "p-1", quantity: 1, unit_price: 100 }],
                        payment_terms: "cash",
                    }),
                ).toEqual({ kind: "not_found" });
            }
            expect(createPending).not.toHaveBeenCalled();
        });
    }

    it("a made-up account id is the same answer", async () => {
        expect(await run(ISR, "get_account_details", { account_id: "NOPE" })).toEqual({ kind: "not_found" });
    });
});

describe("account details and visits", () => {
    it("details never carry the OEM evaluation", async () => {
        const r = await run(ISR, "get_account_details", { account_id: "A1" });
        expect(r.kind).toBe("account");
        expect(JSON.stringify(r)).not.toMatch(/oem|99999/i);
    });

    it("a visit on an account replies with the camera + location link, saves nothing", async () => {
        const r = await run(ASM, "account_visit_link", { account_id: "A2" });
        expect(r).toMatchObject({ kind: "declined", crm_url: expect.stringMatching(/\/visits\/capture\?account=A2$/) });
        expect(createPending).not.toHaveBeenCalled();
    });
});

describe("create_account_quote applier", () => {
    const plan = {
        account_id: "A1",
        product_lines: [{ asset_type: "battery", product_id: "p-1", product_name: "105Ah", model_id: "m", unit_price: 100, quantity: 1 }],
        terms: { dealer_payment_terms: "cash", credit_days: null },
        notes: null,
    };

    it("refuses at Confirm when the account is no longer the user's", async () => {
        const moved = { ...ACCOUNTS.A1 };
        ACCOUNTS.A1 = { ...moved, owner_id: "isr-9" };
        try {
            await expect(
                APPLIERS.create_account_quote.apply({ tx: {} as never, user: ISR, step: 1, actionId: "act-1" } as never, plan),
            ).rejects.toThrow(/owner/i);
            expect(createAccountQuotation).not.toHaveBeenCalled();
        } finally {
            ACCOUNTS.A1 = moved;
        }
    });

    it("writes through the account route's writer, on the executor's transaction", async () => {
        createAccountQuotation.mockResolvedValue({
            quotationId: "q-1",
            versionNo: 2,
            approvalStatus: "pending",
            autoApproved: false,
            afterCommit: async () => ({ quote_number: null }),
        });
        const tx = { tx: true } as never;
        const out = await APPLIERS.create_account_quote.apply({ tx, user: ISR, step: 1, actionId: "act-1" } as never, plan);
        expect(createAccountQuotation).toHaveBeenCalledWith(
            expect.objectContaining({ account: expect.objectContaining({ id: "A1" }), actor: { id: "isr-1", name: "Priya" } }),
            { tx },
        );
        expect(out).toMatchObject({ quotation_id: "q-1", quote_version: 2, approval_status: "pending" });
    });
});
