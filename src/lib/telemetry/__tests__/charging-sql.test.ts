import path from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
    COVERAGE_TRUST_GAP_S,
    MAX_VALID_CURRENT_A,
    MIN_CYCLE_SAMPLES,
    MIN_CYCLE_SOC_GAIN,
    SESSION_GAP_MAX_S,
} from "@/lib/telemetry/charging-math";
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

    it("includes the whole of the `to` day in a custom range", () => {
        // Half-open upper bound, so `to` is advanced by a day: a user picking 01→05
        // June expects the 5th included, not truncated at its first instant.
        const { timePredicate, months, month, from, to } = buildTimeWindow(sql, {
            from: "2026-06-01",
            to: "2026-06-05",
        });
        expect([months, month]).toEqual([null, null]);
        expect([from, to]).toEqual(["2026-06-01", "2026-06-05"]);
        const { text, params } = render(timePredicate);
        expect(flat(text)).toBe("AND time >= $1 AND time < $2");
        expect(params).toEqual(["2026-06-01", "2026-06-06"]);
    });

    it("rolls a custom range over a month and year boundary", () => {
        expect(render(buildTimeWindow(sql, { from: "2026-06-28", to: "2026-06-30" }).timePredicate).params)
            .toEqual(["2026-06-28", "2026-07-01"]);
        expect(render(buildTimeWindow(sql, { from: "2026-12-30", to: "2026-12-31" }).timePredicate).params)
            .toEqual(["2026-12-30", "2027-01-01"]);
    });

    it("takes a custom range ahead of a month, and ignores a half-filled one", () => {
        // Precedence must match the UI, or the caption describes a period the query
        // never ran. A lone `from` is not a range and must not silently win.
        expect(buildTimeWindow(sql, { from: "2026-06-01", to: "2026-06-05", month: "2026-03" }).month)
            .toBeNull();
        expect(buildTimeWindow(sql, { from: "2026-06-01", month: "2026-03" }).month).toBe("2026-03");
        expect(buildTimeWindow(sql, { to: "2026-06-05" }).months).toBe(3);
        expect(buildTimeWindow(sql, { from: "01-06-2026", to: "05-06-2026" }).months).toBe(3);
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
        // Parameters bind in source order: vehicleno and the corrupt-frame bound sit in
        // the `raw` CTE ahead of the time predicate, then each tuning constant as its
        // CTE appears.
        expect(params).toEqual([
            "BAT-1001",
            MAX_VALID_CURRENT_A,
            6,
            SESSION_GAP_MAX_S,
            COVERAGE_TRUST_GAP_S,
            MIN_CYCLE_SOC_GAIN,
            MIN_CYCLE_SAMPLES,
        ]);
        expect(text).toContain("WHERE vehicleno = $1");
        expect(flat(text)).toContain("AND time > now() - (interval '1 month' * $3)");
    });

    it("rejects corrupt CAN frames but keeps a missing current reading", () => {
        const { text } = render(cteFor("BAT-1001", { months: 3 }));
        const one = flat(text);
        expect(one).toContain("payload->'current'->>'value' IS NULL OR ABS((payload->'current'->>'value')::float) <= $2");
    });

    it("requires enough samples and some current before a cycle counts", () => {
        // Two samples describe one straight line through a whole charge — not an integral.
        const { text } = render(cteFor("BAT-1001", { months: 3 }));
        const one = flat(text);
        expect(one).toContain("count(*)::int AS n_samples");
        expect(one).toContain("count(*) FILTER (WHERE pack_current > 0)::int AS n_current_samples");
        expect(one).toContain("AND end_soc > start_soc");
        expect(one).toContain(`AND n_samples >= $${7}`);
        expect(one).toContain("AND n_current_samples > 0");
    });

    it("emits exactly one WITH, opening the chain", () => {
        const { text } = render(cteFor("BAT-1001", { months: 3 }));
        expect(flat(text).startsWith("WITH raw AS (")).toBe(true);
        expect(text.match(/\bWITH\b/g)).toHaveLength(1);
    });

    it("ends at `cycle_valid AS (…)` so a caller can append SELECT or another CTE", () => {
        const { text } = render(cteFor("BAT-1001", { months: 3 }));
        expect(flat(text).endsWith("FROM cycle_stats )")).toBe(true);
        expect(flat(text)).not.toContain("SELECT * FROM cycle_valid");
    });

    it("dedupes on time, so duplicate poller rows cannot zero out the interval", () => {
        // ~96% of telemetry_can rows repeat a timestamp. Without DISTINCT ON, every
        // one of them gets dt_s = 0 and contributes no AH, and LAG over the ties is
        // non-deterministic. This is the single most load-bearing line in the file.
        const { text } = render(cteFor("BAT-1001", { months: 3 }));
        expect(flat(text)).toContain("SELECT DISTINCT ON (time)");
    });

    it("integrates AH as a trapezoid over the real elapsed interval", () => {
        const { text } = render(cteFor("BAT-1001", { months: 3 }));
        expect(flat(text)).toContain(
            "((ABS(pack_current) + ABS(COALESCE(prev_current, pack_current))) / 2.0) * (dt_s / 3600.0)",
        );
        // Not gated on a rising SOC: current flows between whole-percent SOC ticks.
        expect(flat(text)).not.toContain("dsoc > 0 AND pack_current IS NOT NULL");
    });

    it("breaks a session on the configured gap and reads the payload keys the poller writes", () => {
        const { text } = render(cteFor("BAT-1001", { months: 3 }));
        expect(flat(text)).toContain("dsoc >= 0 AND dt_s IS NOT NULL AND dt_s <= $4");
        expect(text).toContain("payload->'soc'->>'value'");
        expect(text).toContain("payload->'current'->>'value'");
        expect(text).toContain("payload->'battery_voltage'->>'value'");
        expect(text).toContain("payload->'rated_capacity'->>'value'");
    });

    it("counts session breaks to group contiguous charging runs", () => {
        const { text } = render(cteFor("BAT-1001", { months: 3 }));
        expect(flat(text)).toContain(
            "SUM(CASE WHEN in_sess = 0 THEN 1 ELSE 0 END) OVER (ORDER BY time) AS break_id",
        );
    });

    it("trims a cycle to the first current-carrying and last rising sample", () => {
        const { text } = render(cteFor("BAT-1001", { months: 3 }));
        const one = flat(text);
        expect(one).toContain(
            "min(time) FILTER (WHERE in_sess = 1 AND pack_current > 0) OVER (PARTITION BY break_id) AS cyc_first",
        );
        // Last *rising* sample, not last current-carrying one: that keeps the CV
        // taper up to 100% inside the cycle, and the idle at 100% out of it.
        expect(one).toContain(
            "max(time) FILTER (WHERE in_sess = 1 AND dsoc > 0) OVER (PARTITION BY break_id) AS cyc_last",
        );
    });

    it("excludes the first in-cycle interval from AH, so the intervals tile the cycle", () => {
        const { text } = render(cteFor("BAT-1001", { months: 3 }));
        expect(flat(text)).toContain("sum(ah_term) FILTER (WHERE time > cyc_first)");
    });

    it("composes into the aggregate query the dashboard runs", () => {
        const cte = cteFor("BAT-1001", { month: "2026-03" });
        const { text, params } = render(sql`
            ${cte}
            SELECT break_id, start_time, ah_charged
            FROM cycle_valid
            WHERE is_valid
        `);
        const one = flat(text);
        expect(one.startsWith("WITH raw AS (")).toBe(true);
        expect(one).toContain(") SELECT break_id, start_time, ah_charged");
        expect(params).toEqual([
            "BAT-1001",
            MAX_VALID_CURRENT_A,
            "2026-03-01",
            "2026-04-01",
            SESSION_GAP_MAX_S,
            COVERAGE_TRUST_GAP_S,
            MIN_CYCLE_SOC_GAIN,
            MIN_CYCLE_SAMPLES,
        ]);
    });

    it("composes into the detail query, which joins the same cycle_valid CTE", () => {
        // Both consumers read the cycle definition from one place, so the exported
        // workbook can never disagree with the dashboard it exists to check.
        const cte = cteFor("BAT-1001", { months: 1 });
        const { text } = render(sql`
            ${cte}
            SELECT g.time, (g.in_cycle AND cv.is_valid) AS in_valid_cycle
            FROM cycled g
            LEFT JOIN cycle_valid cv ON cv.break_id = g.break_id
        `);
        const one = flat(text);
        expect(one).toContain("FROM cycle_stats ) SELECT g.time");
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
