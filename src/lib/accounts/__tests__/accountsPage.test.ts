/**
 * ID 203 — the Accounts list: no count query when page 1 is short, and the
 * two-minute server cache (shared promise, failures not kept, cleared on write).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();
vi.mock("@/lib/db", () => ({ db: { execute: (q: unknown) => execute(q) } }));
vi.mock("../accountsScreen", () => ({
    accountsPageSql: async () => "PAGE",
    accountsTotalSql: async () => "TOTAL",
}));

const { listAccountsPage, cachedAccounts, clearAccountsCache, AccountsListQuerySchema } = await import("../accountsPage");

const row = (id: string) => ({ id, name: id, gstin_missing: 0, created_at: "2026-10-01T00:00:00Z", closed: false });

describe("listAccountsPage", () => {
    beforeEach(() => execute.mockReset());

    it("does not count when the first page is short — the rows are the total", async () => {
        execute.mockImplementation(async (q: string) => (q === "PAGE" ? [row("a"), row("b")] : [{ n: 999 }]));
        const r = await listAccountsPage(AccountsListQuerySchema.parse({ limit: 100, offset: 0 }));
        expect(r.filtered_total).toBe(2);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(r.rows[0].gstin_missing).toBe(false);
        expect(typeof r.read_at).toBe("number");
    });

    it("counts when the page is full or not the first", async () => {
        execute.mockImplementation(async (q: string) => (q === "PAGE" ? [row("a"), row("b")] : [{ n: "57" }]));
        expect((await listAccountsPage(AccountsListQuerySchema.parse({ limit: 2, offset: 0 }))).filtered_total).toBe(57);
        expect((await listAccountsPage(AccountsListQuerySchema.parse({ limit: 100, offset: 100 }))).filtered_total).toBe(57);
    });
});

describe("cachedAccounts", () => {
    beforeEach(() => clearAccountsCache());

    it("loads once and serves the same answer until cleared", async () => {
        const load = vi.fn(async () => ({ total: 5 }));
        expect(await cachedAccounts("counts", load)).toEqual({ total: 5 });
        expect(await cachedAccounts("counts", load)).toEqual({ total: 5 });
        expect(load).toHaveBeenCalledTimes(1);
        clearAccountsCache();
        await cachedAccounts("counts", load);
        expect(load).toHaveBeenCalledTimes(2);
    });

    it("does not keep a failure", async () => {
        const bad = vi.fn(async () => {
            throw new Error("db down");
        });
        await expect(cachedAccounts("owners", bad)).rejects.toThrow("db down");
        await Promise.resolve();
        const good = vi.fn(async () => "ok");
        expect(await cachedAccounts("owners", good)).toBe("ok");
    });
});
