// ID 243: a list API sorts only by its own columns; blanks stay last both ways.
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { parseSortParam, sortOrderSql } from "../sortParam";

const ALLOWED = ["amount_owed", "name"] as const;
const dialect = new PgDialect();

describe("parseSortParam / sortOrderSql", () => {
    it("accepts only allowed columns", () => {
        expect(parseSortParam(new URLSearchParams("sort=amount_owed&dir=desc"), ALLOWED)).toEqual({ key: "amount_owed", dir: "desc" });
        expect(parseSortParam(new URLSearchParams("sort=name"), ALLOWED)).toEqual({ key: "name", dir: "asc" });
        expect(parseSortParam(new URLSearchParams("sort=password; DROP TABLE x"), ALLOWED)).toBeNull();
        expect(parseSortParam(new URLSearchParams("inv_sort=name&inv_dir=desc"), ALLOWED, { prefix: "inv_" })).toEqual({ key: "name", dir: "desc" });
    });
    it("orders with NULLS LAST and the list's own order as tie-breaker", () => {
        const cols = { amount_owed: sql`a.owed`, name: sql`a.name` };
        const q = dialect.sqlToQuery(sortOrderSql({ key: "amount_owed", dir: "desc" }, cols, sql`a.id`)).sql;
        expect(q).toBe("a.owed DESC NULLS LAST, a.id");
        expect(dialect.sqlToQuery(sortOrderSql({ key: "name", dir: "asc" }, cols, sql`a.id`)).sql).toBe("a.name ASC NULLS LAST, a.id");
        expect(dialect.sqlToQuery(sortOrderSql(null, cols, sql`a.id`)).sql).toBe("a.id");
    });
});
