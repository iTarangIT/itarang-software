// ID 243 — the columns the Leads list (/leads, GET /api/dealer-leads) sorts by.
// The list is paged, so the API does the ordering (leadListQuery.ts maps each
// key to SQL); this file has no database in it so the page can read the same
// list for its header cells. Anything else in ?sort= is ignored.

import type { SortSpec, SortState } from "@/components/shared/tableSortCore";

export const LEAD_LIST_SORT_KEYS = [
    "dealer",
    "city",
    "status",
    "interest",
    "owner",
    "asm",
    "last_activity",
    "idle",
    "source",
    "created",
] as const;
export type LeadListSortKey = (typeof LEAD_LIST_SORT_KEYS)[number];

/** Header specs: the type decides which way a column opens on its first click. */
export const LEAD_LIST_SORT_SPECS: SortSpec<unknown>[] = [
    { key: "dealer", type: "text" },
    { key: "city", type: "text" },
    { key: "status", type: "text" },
    // Hot, Warm, Cold ranked 3/2/1, so the first click puts Hot on top.
    { key: "interest", type: "number" },
    { key: "owner", type: "text" },
    { key: "asm", type: "text" },
    { key: "last_activity", type: "date" },
    { key: "idle", type: "number" },
    { key: "source", type: "text" },
    { key: "created", type: "date" },
];

/** The sort a link asks for (`?sort=&dir=`), if it names a Leads list column. */
export function leadSortFromParams(sp: URLSearchParams | null | undefined): SortState | null {
    const key = sp?.get("sort") ?? "";
    if (!(LEAD_LIST_SORT_KEYS as readonly string[]).includes(key)) return null;
    return { key, dir: sp?.get("dir") === "desc" ? "desc" : "asc" };
}
