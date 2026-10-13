import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";

// The queue builders import the db client; nothing here executes a query.
vi.mock("@/lib/db", () => ({ db: { execute: vi.fn(async () => []) } }));

const { ownerScopeSql } = await import("@/lib/users/teamSql");
const { tabFilter: isrTab } = await import("@/lib/inside-sales/queryBuilder");
const { tabFilter: asmTab } = await import("@/lib/asm/queryBuilder");

const dialect = new PgDialect();
const render = (q: SQL) => {
    const { sql: text, params } = dialect.sqlToQuery(q);
    return { text: text.replace(/\s+/g, " ").trim(), params };
};

// ID 155 — Sonu manages a1 and a2.
const SONU = "sonu";
const TEAM = ["a1", "a2"];

describe("ownerScopeSql (ID 155)", () => {
    it("is the old `= me` clause without a team", () => {
        expect(render(ownerScopeSql(sql`dl.current_owner_id`, SONU, []))).toEqual({
            text: "dl.current_owner_id = $1",
            params: [SONU],
        });
        expect(render(ownerScopeSql(sql`dl.current_owner_id`, SONU, null))).toEqual({
            text: "dl.current_owner_id = $1",
            params: [SONU],
        });
    });

    it("is `IN (me, team)` for a manager", () => {
        expect(render(ownerScopeSql(sql`dl.current_owner_id`, SONU, TEAM))).toEqual({
            text: "dl.current_owner_id IN ($1, $2, $3)",
            params: [SONU, "a1", "a2"],
        });
    });
});

describe("queue tabs for a manager (ID 155)", () => {
    it("ISR own tabs cover the team; the pool and Team tabs do not change", () => {
        for (const tab of ["my_open", "follow_ups", "my_closed"] as const) {
            const r = render(isrTab(tab, SONU, TEAM));
            expect(r.text, tab).toContain("dl.current_owner_id IN (");
            expect(r.params.slice(0, 3), tab).toEqual([SONU, "a1", "a2"]);
        }
        for (const tab of ["unassigned", "team"] as const) {
            expect(render(isrTab(tab, SONU, TEAM)), tab).toEqual(render(isrTab(tab, SONU)));
        }
    });

    it("ASM own tabs cover the team on their own column; territory stays the viewer's", () => {
        expect(render(asmTab("my_visits", SONU, TEAM)).text).toContain("dl.current_owner_id IN (");
        expect(render(asmTab("today", SONU, TEAM)).text).toContain("dl.asm_id IN (");
        expect(render(asmTab("my_closed", SONU, TEAM)).text).toContain("dl.closing_owner_id IN (");
        for (const tab of ["territory", "unclaimed"] as const) {
            expect(render(asmTab(tab, SONU, TEAM)), tab).toEqual(render(asmTab(tab, SONU)));
        }
    });

    it("a team member (no reports) gets exactly the old SQL", () => {
        for (const tab of ["my_open", "follow_ups", "my_closed"] as const) {
            const r = render(isrTab(tab, "a1", []));
            expect(r.text, tab).toContain("dl.current_owner_id = $1");
            expect(r.text, tab).not.toContain(" IN ($1");
        }
        expect(render(asmTab("my_visits", "a1", [])).text).toContain("dl.current_owner_id = $1");
    });
});
