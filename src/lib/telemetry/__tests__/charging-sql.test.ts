import path from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
    buildTimeWindow,
    cycleCTEs,
    type IotSql,
} from "@/lib/telemetry/charging-sql";

// postgres.js only serialises a query when a connection sends it, so we reach for
// its internal stringifier to render the composed SQL — nested fragments inlined,
// parameters numbered — without opening a socket.
//
// Imported by absolute path for two reasons: the package's `exports` map hides the
// subpath, and the CJS build declares its own `Query` class. `stringifyValue` inlines
// a nested fragment via `value instanceof Query`, so a CJS `stringify` would fail that
// check against our ESM-built fragments and silently bind the CTE as a parameter.
const { stringify } = (await import(
    pathToFileURL(
        path.join(process.cwd(), "node_modules/postgres/src/types.js"),
    ).href
)) as {
    stringify: (
        q: unknown,
        string: string,
        value: unknown,
        parameters: unknown[],
        types: unknown[],
        options: unknown,
    ) => string;
};

// Never connected: postgres() is lazy, and we never await a query.
const sql = postgres("postgres://u:p@127.0.0.1:1/db", { prepare: false }) as IotSql;
const sqlOptions = (sql as unknown as { options: unknown }).options;

interface Rendered {
    text: string;
    params: unknown[];
}

function render(query: unknown): Rendered {
    const q = query as { strings: TemplateStringsArray; args: unknown[] };
    const params: unknown[] = [];
    const text = stringify(q, q.strings[0], q.args[0], params, [], sqlOptions);
    return { text, params };
}

/** Collapse whitespace so assertions do not depend on the SQL's indentation. */
function flat(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function cteFor(vehicleno: string, opts: { months?: number; month?: string }) {
    const { timePredicate } = buildTimeWindow(sql, opts);
    return cycleCTEs(sql, vehicleno, timePredicate);
}

describe("buildTimeWindow", () => {
    it("uses a half-open range for a specific calendar month", () => {
        const { timePredicate, months, month } = buildTimeWindow(sql, { month: "2026-03" });
        expect(months).toBeNull();
        expect(month).toBe("2026-03");
        const { text, params } = render(timePredicate);
        expect(flat(text)).toBe("AND time >= $1 AND time < $2");
        expect(params).toEqual(["2026-03-01", "2026-04-01"]);
    });

    it("rolls over the year boundary in December", () => {
        const { timePredicate } = buildTimeWindow(sql, { month: "2026-12" });
        expect(render(timePredicate).params).toEqual(["2026-12-01", "2027-01-01"]);
    });

    it("falls back to a rolling window, defaulting and clamping to 1/3/6 months", () => {
        expect(buildTimeWindow(sql, {}).months).toBe(3);
        expect(buildTimeWindow(sql, { months: 6 }).months).toBe(6);
        expect(buildTimeWindow(sql, { months: 99 }).months).toBe(3);
        expect(buildTimeWindow(sql, { month: "not-a-month" }).months).toBe(3);

        const { timePredicate } = buildTimeWindow(sql, { months: 6 });
        const { text, params } = render(timePredicate);
        expect(flat(text)).toBe("AND time > now() - (interval '1 month' * $1)");
        expect(params).toEqual([6]);
    });
});

describe("cycleCTEs", () => {
    it("inlines the time-window fragment and orders parameters after vehicleno", () => {
        const { text, params } = render(cteFor("BAT-1001", { months: 6 }));
        // vehicleno binds first because it appears before the predicate.
        expect(params).toEqual(["BAT-1001", 6]);
        expect(text).toContain("WHERE vehicleno = $1");
        expect(flat(text)).toContain("AND time > now() - (interval '1 month' * $2)");
    });

    it("emits exactly one WITH, opening the chain", () => {
        const { text } = render(cteFor("BAT-1001", { months: 3 }));
        expect(flat(text).startsWith("WITH raw AS (")).toBe(true);
        expect(text.match(/\bWITH\b/g)).toHaveLength(1);
    });

    it("ends at `grouped AS (…)` so a caller can append SELECT or another CTE", () => {
        const { text } = render(cteFor("BAT-1001", { months: 3 }));
        expect(flat(text).endsWith("FROM flagged )")).toBe(true);
        expect(flat(text)).not.toContain("SELECT * FROM grouped");
    });

    it("keeps the 20-minute session gap and the payload keys the poller writes", () => {
        const { text } = render(cteFor("BAT-1001", { months: 3 }));
        // A literal, not a bound parameter — this is the SQL that runs today.
        expect(flat(text)).toContain("dsoc >= 0 AND dt_s IS NOT NULL AND dt_s <= 1200");
        expect(text).toContain("payload->'soc'->>'value'");
        expect(text).toContain("payload->'current'->>'value'");
        expect(text).toContain("payload->'battery_voltage'->>'value'");
    });

    it("counts session breaks to group contiguous charging runs", () => {
        const { text } = render(cteFor("BAT-1001", { months: 3 }));
        expect(flat(text)).toContain(
            "SUM(CASE WHEN in_sess = 0 THEN 1 ELSE 0 END) OVER (ORDER BY time) AS break_id",
        );
    });

    it("composes into the aggregate query the dashboard runs", () => {
        const cte = cteFor("BAT-1001", { month: "2026-03" });
        const { text, params } = render(sql`
            ${cte}
            SELECT break_id::int AS break_id, min(time) AS start_time
            FROM grouped
            WHERE in_sess = 1
            GROUP BY break_id
            HAVING (max(soc_pct) - min(soc_pct)) >= 5
        `);
        const one = flat(text);
        expect(one.startsWith("WITH raw AS (")).toBe(true);
        expect(one).toContain(") SELECT break_id::int AS break_id");
        expect(params).toEqual(["BAT-1001", "2026-03-01", "2026-04-01"]);
    });

    it("composes into the detail query by appending a second CTE after a comma", () => {
        const cte = cteFor("BAT-1001", { months: 1 });
        const { text } = render(sql`
            ${cte}, cycle_stats AS (
                SELECT break_id FROM grouped WHERE in_sess = 1 GROUP BY break_id
            )
            SELECT g.time FROM grouped g
            LEFT JOIN cycle_stats cs ON cs.break_id = g.break_id
        `);
        const one = flat(text);
        // The comma must land directly after the fragment's closing paren.
        expect(one).toContain("FROM flagged ), cycle_stats AS (");
        expect(one.match(/\bWITH\b/g)).toHaveLength(1);
    });

    it("returns a fresh fragment per call, so reuse cannot leak state", () => {
        const a = cteFor("BAT-A", { months: 3 });
        const b = cteFor("BAT-B", { months: 3 });
        expect(a).not.toBe(b);
        expect(render(a).params[0]).toBe("BAT-A");
        expect(render(b).params[0]).toBe("BAT-B");
    });
});
