// Parsing the ASM queue's filter params, in one place.
//
// Four routes read the same query string — the list, the tab badges, the region
// facets and the CSV export — and the export exists precisely so that "give me
// what I am looking at" is answerable. If any of the four parsed the params
// slightly differently the sheet would not match the screen, which is the one
// thing an export must never do.
//
// Server-only by convention (it is imported by route handlers), but it has no
// db import: the shared five come from @/lib/leads/queueFilters, and the two
// ASM-only ones are validated against the vocabularies in ./types.

import { readQueueFilters, type QueueFilters } from "@/lib/leads/queueFilters";
import { readQueueSort, type QueueSort } from "@/lib/leads/queueSort";
import { VISIT_OUTCOME, VISIT_STATUS } from "./types";

export type AsmQueueFilterParams = {
    filters: QueueFilters;
    visitStatus: string | null;
    visitOutcome: string | null;
    /** Order, not a filter — the list and the CSV honour it, the counts ignore it. */
    sort: QueueSort;
};

/**
 * VALIDATED, not trusted. An unrecognised visit status would seed a <select>
 * with no matching option on the way back out, which renders as a blank
 * selection that is silently filtering the list — and, on the SQL side, as a
 * filter that matches nothing for a reason nobody can see.
 */
export function readAsmQueueFilters(sp: URLSearchParams): AsmQueueFilterParams {
    const visitStatus = sp.get("visit_status") ?? "";
    const visitOutcome = sp.get("visit_outcome") ?? "";
    return {
        filters: readQueueFilters(sp),
        sort: readQueueSort(sp),
        visitStatus: (VISIT_STATUS as readonly string[]).includes(visitStatus)
            ? visitStatus
            : null,
        visitOutcome: (VISIT_OUTCOME as readonly string[]).includes(visitOutcome)
            ? visitOutcome
            : null,
    };
}
