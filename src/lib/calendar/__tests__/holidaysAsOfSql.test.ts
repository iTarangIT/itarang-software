import { describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// ID 85 #6 — past period counts use the holidays as they stood at the end.
const execute = vi.fn(async () => [{ ok: true }]);
vi.mock("@/lib/db", () => ({ db: { execute } }));
const { primeHolidayLog, workingDaysBetweenAsOfSql, workingDaysBetweenSql } = await import("../holidays");

const render = (q: ReturnType<typeof sql>) => new PgDialect().sqlToQuery(q).sql.replace(/\s+/g, " ");

describe("workingDaysBetweenAsOfSql", () => {
    it("is today's list until the holiday log is found", () => {
        const a = render(workingDaysBetweenAsOfSql(sql`x.a`, sql`x.b`));
        expect(a).toBe(render(workingDaysBetweenSql(sql`x.a`, sql`x.b`)));
        expect(a).not.toContain("holiday_calendar_log");
    });

    it("reads each date's state at `to` from the log once it is there", async () => {
        await primeHolidayLog();
        const q = render(workingDaysBetweenAsOfSql(sql`x.a`, sql`x.b`));
        expect(q).toContain("holiday_calendar_log");
        // The last add / remove at or before the end, then the first-change rule, then today's list.
        expect(q).toMatch(/hl\.changed_at <= \(x\.b\)/);
        expect(q.indexOf("ORDER BY hl.changed_at DESC")).toBeLessThan(q.indexOf("ORDER BY hl.changed_at, hl.id"));
        expect(q).toContain("hc.is_active IS NOT FALSE");
        expect(q).toContain("hl.action <> 'rename'");
    });
});
