/**
 * The Accounts screen's list (tracker P1-1 / P1-2; ID 203 speed-up) — one
 * function for GET /api/admin/accounts and the page's server-side first page,
 * plus the short server caches of the numbers that do not depend on the
 * filters (tab counts, owner dropdowns).
 *
 * ID 203 (27 Oct): the page now arrives with its first rows; the total is not
 * counted when page 1 is short (it is the number of rows); the tab counts and
 * the owner lists are cached for two minutes in this process and cleared by
 * every route that changes an owner, a closure or a GSTIN.
 */
import { z } from "zod";

import { accountsPageSql, accountsTotalSql } from "./accountsScreen";

export const AccountsListQuerySchema = z.object({
    q: z.string().trim().max(200).optional(),
    owner: z.union([z.literal("none"), z.string().uuid()]).optional(),
    gstin_missing: z.enum(["1", "true"]).optional(),
    came_through: z.enum(["lead", "direct", "unknown"]).optional(),
    status: z.string().trim().max(30).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
});
export type AccountsListQuery = z.infer<typeof AccountsListQuerySchema>;

export type AccountsListRow = {
    id: string;
    name: string;
    gstin: string | null;
    gstin_missing: boolean;
    city: string | null;
    state: string | null;
    status: string;
    created_at: string | null;
    owner_user_id: string | null;
    owner_name: string | null;
    onboarded_by_user_id: string | null;
    onboarded_by_name: string | null;
    came_through: string | null;
    source_dealer_lead_id: string | null;
    source_application_id: string | null;
    /** ID 5 — closed by hand (E-332), with the reason. */
    closed: boolean;
    closed_reason: string | null;
};

export type AccountsListPage = { rows: AccountsListRow[]; filtered_total: number; limit: number; offset: number; read_at: number };

/** One page of the list and the filtered total. */
export async function listAccountsPage(f: AccountsListQuery): Promise<AccountsListPage> {
    const { db } = await import("@/lib/db");
    const filters = {
        q: f.q,
        owner: f.owner,
        gstin_missing: Boolean(f.gstin_missing),
        came_through: f.came_through,
        status: f.status,
    };
    const rows = (await db.execute(await accountsPageSql(filters, f.limit, f.offset))) as unknown as AccountsListRow[];
    // A short first page IS the whole list: no count needed.
    const total =
        f.offset === 0 && rows.length < f.limit
            ? rows.length
            : Number(
                  ((await db.execute(await accountsTotalSql(filters))) as unknown as Array<{ n: number | string }>)[0]?.n ?? 0,
              );
    return {
        rows: rows.map((r) => ({
            ...r,
            gstin_missing: Boolean(r.gstin_missing),
            created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
        })),
        filtered_total: total,
        limit: f.limit,
        offset: f.offset,
        read_at: Date.now(),
    };
}

// ─────────────────────────────── server cache ───────────────────────────────

const CACHE_MS = 2 * 60_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

/** `load()` once per two minutes per key, in this process. A failure is not kept. */
export function cachedAccounts<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Promise<T>;
    const value = load();
    value.catch(() => cache.delete(key));
    cache.set(key, { at: Date.now(), value });
    return value;
}

/** After an assignment, a leaver move, a closure or a GSTIN change. */
export function clearAccountsCache(): void {
    cache.clear();
}
