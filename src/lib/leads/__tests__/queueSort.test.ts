// Tests for the shared queue sort — the URL round-trip and the SQL fragment.
//
// The invariants that matter:
//   1. an unknown sort key or direction never survives parsing (it is the only
//      thing that stops user text reaching an ORDER BY)
//   2. write → read is the identity for every valid combination
//   3. the default writes nothing, so an unsorted URL stays clean
//   4. the SQL fragment always ends with the tab's own order (the tiebreak) and
//      starts with the user's column when one is set

import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
    EMPTY_QUEUE_SORT,
    QUEUE_SORT_DIRS,
    QUEUE_SORT_KEYS,
    readQueueSort,
    writeQueueSort,
} from "../queueSort";
import { queueSortOrder } from "../queueFilterSql";

function sqlText(q: ReturnType<typeof sql>): string {
    // Flatten the query chunks to a single string for shape assertions.
    return q.queryChunks
        .map((c) => {
            if (typeof c === "string") return c;
            if (c && typeof c === "object" && "value" in c) {
                const v = (c as { value: unknown }).value;
                return Array.isArray(v) ? v.join("") : String(v);
            }
            if (c && typeof c === "object" && "queryChunks" in c) {
                return sqlText(c as ReturnType<typeof sql>);
            }
            return "?";
        })
        .join("");
}

describe("readQueueSort", () => {
    it("drops an unknown sort key", () => {
        expect(readQueueSort(new URLSearchParams("sort=phone&dir=desc"))).toEqual(
            EMPTY_QUEUE_SORT,
        );
        expect(readQueueSort(new URLSearchParams("sort=1;DROP&dir=asc"))).toEqual(
            EMPTY_QUEUE_SORT,
        );
    });

    it("falls back to asc on an unknown direction", () => {
        expect(readQueueSort(new URLSearchParams("sort=city&dir=sideways"))).toEqual({
            sort: "city",
            dir: "asc",
        });
    });

    it("round-trips every valid combination", () => {
        for (const sort of QUEUE_SORT_KEYS) {
            for (const dir of QUEUE_SORT_DIRS) {
                const p = writeQueueSort(new URLSearchParams(), { sort, dir });
                expect(readQueueSort(p)).toEqual({ sort, dir });
            }
        }
    });

    it("writes nothing for the default", () => {
        expect(writeQueueSort(new URLSearchParams(), EMPTY_QUEUE_SORT).toString()).toBe("");
        // asc is the default direction, so it is not spelled out either.
        expect(
            writeQueueSort(new URLSearchParams(), { sort: "state", dir: "asc" }).toString(),
        ).toBe("sort=state");
    });
});

describe("queueSortOrder", () => {
    const tab = sql`dl.created_at DESC`;

    it("is just the tab order when no sort is set", () => {
        expect(sqlText(queueSortOrder(undefined, tab))).toBe("ORDER BY dl.created_at DESC");
        expect(sqlText(queueSortOrder(EMPTY_QUEUE_SORT, tab))).toBe(
            "ORDER BY dl.created_at DESC",
        );
    });

    it("puts the user's column first, NULLS LAST, and keeps the tab order as tiebreak", () => {
        const t = sqlText(queueSortOrder({ sort: "city", dir: "desc" }, tab));
        expect(t.startsWith("ORDER BY NULLIF(btrim(dl.city), '') DESC NULLS LAST, ")).toBe(true);
        expect(t.endsWith("dl.created_at DESC")).toBe(true);
    });

    it("ranks status by pipeline stage rather than alphabetically", () => {
        const t = sqlText(queueSortOrder({ sort: "status", dir: "asc" }, tab));
        expect(t).toContain("CASE dl.lead_status");
        expect(t.indexOf("New_Unassigned")).toBeLessThan(t.indexOf("Lost"));
    });

    it("ranks interest by warmth", () => {
        const t = sqlText(queueSortOrder({ sort: "interest", dir: "asc" }, tab));
        expect(t.indexOf("'cold'")).toBeLessThan(t.indexOf("'hot'"));
    });
});
