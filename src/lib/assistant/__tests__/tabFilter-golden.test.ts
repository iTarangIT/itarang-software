import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// Regression guard for exporting tabFilter() from the ISR and ASM queue
// builders (Gate 2). The scope predicate reuses those clauses, so exporting
// them must not change a single character of what any queue tab runs.
//
// This file was committed BEFORE the export commit, against the private
// tabFilter. The snapshot is the SQL text + bound params of every tab's list
// and count query; the export commit must leave it byte-identical. Same SQL,
// same params ⇒ same rows, without needing a database.

const captured: SQL[] = [];
vi.mock("@/lib/db", () => ({
    db: {
        execute: vi.fn(async (q: SQL) => {
            captured.push(q);
            return [{ c: "0" }];
        }),
    },
}));

const { fetchQueueRows, countQueueRows } = await import("@/lib/inside-sales/queryBuilder");
const { fetchAsmQueueRows, countAsmQueueRows } = await import("@/lib/asm/queryBuilder");
const { QUEUE_TABS } = await import("@/lib/inside-sales/types");
const { ASM_QUEUE_TABS } = await import("@/lib/asm/types");

const dialect = new PgDialect();
const render = (q: SQL) => {
    const { sql, params } = dialect.sqlToQuery(q);
    return { sql: sql.replace(/\s+/g, " ").trim(), params };
};

beforeEach(() => {
    captured.length = 0;
});

describe("queue SQL is unchanged by exporting tabFilter", () => {
    for (const tab of QUEUE_TABS) {
        it(`ISR ${tab}`, async () => {
            await fetchQueueRows({ tab, userId: "user-1", page: 2, limit: 10, q: "abc" });
            await countQueueRows({ tab, userId: "user-1", q: "abc" });
            expect(captured.map(render)).toMatchSnapshot();
        });
    }

    for (const tab of ASM_QUEUE_TABS) {
        it(`ASM ${tab}`, async () => {
            await fetchAsmQueueRows({ tab, asmId: "asm-1", page: 2, limit: 10, q: "abc" });
            await countAsmQueueRows({ tab, asmId: "asm-1", q: "abc" });
            expect(captured.map(render)).toMatchSnapshot();
        });
    }
});
