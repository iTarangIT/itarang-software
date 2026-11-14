// ID 243 — the server half of the shared table sort (components/shared/TableSort.tsx
// useUrlTableSort, mode "server"). A list API reads `sort` / `dir` from the request and
// accepts ONLY its own columns: an unknown key is ignored, never written into SQL as text.
// Blank values stay at the bottom in both directions, as on the client.

import { sql, type SQL } from "drizzle-orm";

export type ServerSort<K extends string> = { key: K; dir: "asc" | "desc" };

/** The sort the request asked for, if it names an allowed column. */
export function parseSortParam<K extends string>(
    sp: URLSearchParams,
    allowed: readonly K[],
    opts: { prefix?: string } = {},
): ServerSort<K> | null {
    const key = sp.get(`${opts.prefix ?? ""}sort`) ?? "";
    if (!(allowed as readonly string[]).includes(key)) return null;
    return { key: key as K, dir: sp.get(`${opts.prefix ?? ""}dir`) === "desc" ? "desc" : "asc" };
}

/**
 * ORDER BY for an allowed sort. `columns` maps each allowed key to its SQL expression;
 * `fallback` is the list's own order, used as the tie-breaker (so page 2 carries on).
 */
export function sortOrderSql<K extends string>(sort: ServerSort<K> | null, columns: Record<K, SQL>, fallback: SQL): SQL {
    if (!sort) return fallback;
    const col = columns[sort.key];
    const dir = sort.dir === "desc" ? sql`DESC` : sql`ASC`;
    return sql`${col} ${dir} NULLS LAST, ${fallback}`;
}
