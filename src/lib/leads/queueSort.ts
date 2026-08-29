/**
 * The sort the Inside Sales and ASM queues share — see ./queueFilters for the
 * filters they share and the reasoning behind holding the common shape here.
 *
 * CLIENT-SAFE — no `db` import (the filter bar reads the vocabulary).
 *
 * SERVER-SIDE ON PURPOSE. Both queues page at 25 rows, so a sort applied to the
 * rows in the browser would order one page of forty and present it as the list
 * — the hazard `TableSort.tsx` warns about. The sort therefore travels as two
 * query params (`sort`, `dir`) through the same pipe as the filters, and the
 * SQL half lives in ./queueFilterSql (`queueSortOrder`).
 *
 * `sort: ""` means "the tab's own order" — the default every tab has today.
 */

export const QUEUE_SORT_KEYS = ["status", "interest", "state", "city"] as const;
export type QueueSortKey = (typeof QUEUE_SORT_KEYS)[number];

export const QUEUE_SORT_DIRS = ["asc", "desc"] as const;
export type QueueSortDir = (typeof QUEUE_SORT_DIRS)[number];

export type QueueSort = {
    /** Which column; "" = the tab's default order. */
    sort: QueueSortKey | "";
    dir: QueueSortDir;
};

export const EMPTY_QUEUE_SORT: QueueSort = { sort: "", dir: "asc" };

export const QUEUE_SORT_OPTIONS: { value: QueueSortKey | ""; label: string }[] = [
    { value: "", label: "Default order" },
    { value: "status", label: "Lead status" },
    { value: "interest", label: "Interest" },
    { value: "state", label: "State" },
    { value: "city", label: "City" },
];

/**
 * What "ascending" means per key, for the direction button's tooltip. Status
 * and interest are NOT alphabetical — see queueSortOrder — so the label has to
 * say what the arrow actually does.
 */
export const QUEUE_SORT_ASC_LABEL: Record<QueueSortKey, string> = {
    status: "Pipeline order (Unassigned → Lost)",
    interest: "Coldest first",
    state: "A → Z",
    city: "A → Z",
};

export function hasQueueSort(s: QueueSort): boolean {
    return s.sort !== "";
}

/**
 * Read the sort back off a URL. VALIDATED, not trusted — an unknown key would
 * seed a <select> with no matching option, and on the SQL side it is never
 * allowed near an ORDER BY as text.
 */
export function readQueueSort(sp: URLSearchParams): QueueSort {
    const sort = sp.get("sort") ?? "";
    const dir = (sp.get("dir") ?? "asc").toLowerCase();
    if (!(QUEUE_SORT_KEYS as readonly string[]).includes(sort)) return { ...EMPTY_QUEUE_SORT };
    return {
        sort: sort as QueueSortKey,
        dir: (QUEUE_SORT_DIRS as readonly string[]).includes(dir) ? (dir as QueueSortDir) : "asc",
    };
}

/** Write the sort onto a URLSearchParams. The default writes no param at all. */
export function writeQueueSort(p: URLSearchParams, s: QueueSort): URLSearchParams {
    if (s.sort) {
        p.set("sort", s.sort);
        if (s.dir !== "asc") p.set("dir", s.dir);
    }
    return p;
}
