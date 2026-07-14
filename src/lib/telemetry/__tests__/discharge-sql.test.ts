import path from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { SESSION_GAP_MAX_S } from "@/lib/telemetry/charging-math";
import {
    DEEP_DISCHARGE_ENTER_PCT,
    DEEP_DISCHARGE_EXIT_PCT,
    MIN_DISCHARGE_SOC_DROP,
} from "@/lib/telemetry/discharge-math";
import { buildTimeWindow, type IotSql } from "@/lib/telemetry/charging-sql";
import { dischargeCTEs, deepDischargeCTEs } from "@/lib/telemetry/discharge-sql";

// Same trick as charging-sql.test.ts: render the composed SQL through postgres.js's own
// stringifier so nested fragments are inlined and parameters numbered, without a socket.
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

const sql = postgres("postgres://u:p@127.0.0.1:1/db", { prepare: false }) as IotSql;
const sqlOptions = (sql as unknown as { options: unknown }).options;

function render(query: unknown): { text: string; params: unknown[] } {
    const q = query as { strings: TemplateStringsArray; args: unknown[] };
    const params: unknown[] = [];
    const text = stringify(q, q.strings[0], q.args[0], params, [], sqlOptions);
    return { text, params };
}

const flat = (t: string) => t.replace(/\s+/g, " ").trim();

const dischargeFor = (v: string) => {
    const { timePredicate } = buildTimeWindow(sql, { months: 3 });
    return dischargeCTEs(sql, v, timePredicate);
};
const deepFor = (v: string) => {
    const { timePredicate } = buildTimeWindow(sql, { months: 3 });
    return deepDischargeCTEs(sql, v, timePredicate);
};

describe("dischargeCTEs", () => {
    it("composes the shared sample prefix rather than restating it", () => {
        const one = flat(render(dischargeFor("BAT-1")).text);
        // Same dedupe as the charge chain — ~96% of telemetry_can rows repeat a timestamp,
        // and a second, separately-maintained copy of this filter is how they drift apart.
        expect(one.startsWith("WITH raw AS ( SELECT DISTINCT ON (time)")).toBe(true);
        expect(one).toContain("EXTRACT(EPOCH FROM (time - LAG(time) OVER w)) AS dt_s");
        expect(one).toContain("((ABS(pack_current) + ABS(COALESCE(prev_current, pack_current))) / 2.0)");
        // One WITH, opening the chain — a caller appends SELECT.
        expect(render(dischargeFor("BAT-1")).text.match(/\bWITH\b/g)).toHaveLength(1);
    });

    it("**does not accrue Ah on flat-SOC intervals** — the parked-vehicle guard", () => {
        // THE load-bearing assertion in this file.
        //
        // The charge chain deliberately accrues on every interval in the cycle, flat ones
        // included, so the intervals tile the cycle exactly. Copying that here bills a parked
        // vehicle at the last trip's current: a discharge cycle legitimately contains a park
        // (it runs until the battery is recharged), and LAG carries ~40 A into a ten-hour
        // flat stretch. Measured at +2.9% on the reference battery.
        const one = flat(render(dischargeFor("BAT-1")).text);
        expect(one).toContain("sum(ah_term) FILTER (WHERE time > cyc_first AND dsoc < 0) AS ah_coulomb");
        // And specifically NOT the charge side's unconditional form.
        expect(one).not.toContain("sum(ah_term) FILTER (WHERE time > cyc_first) AS ah_coulomb");
    });

    it("trims on falling SOC at BOTH ends, never on current", () => {
        // Current is an unsigned magnitude and a parked vehicle draws a quiescent current
        // continuously, so a current-based anchor would start the discharge in the car park.
        const one = flat(render(dischargeFor("BAT-1")).text);
        expect(one).toContain("min(time) FILTER (WHERE in_sess = 1 AND dsoc < 0) OVER (PARTITION BY break_id) AS first_fall");
        expect(one).toContain("max(time) FILTER (WHERE in_sess = 1 AND dsoc < 0) OVER (PARTITION BY break_id) AS last_fall");
        expect(one).toContain("COALESCE( max(time) FILTER (WHERE in_sess = 1 AND time < first_fall) OVER (PARTITION BY break_id), first_fall ) AS cyc_first");
        expect(one).not.toContain("pack_current > 0) OVER (PARTITION BY break_id) AS cyc_first");
    });

    it("ends the session when SOC rises — the mirror of the charge rule", () => {
        const { text, params } = render(dischargeFor("BAT-1"));
        expect(flat(text)).toContain("CASE WHEN dsoc <= 0 AND dt_s IS NOT NULL AND dt_s <=");
        expect(params).toContain(SESSION_GAP_MAX_S);
    });

    it("counts a discharge on the SOC drop alone, with no sampling-density gate", () => {
        // The charge side lost 70% of real events to a sample floor in its detection gate.
        // That mistake is available here and is not being made: is_valid asks only whether
        // SOC fell, and by enough to matter.
        const { text, params } = render(dischargeFor("BAT-1"));
        const one = flat(text);
        expect(one).toContain("start_soc > end_soc");
        expect(one).toContain("(start_soc - end_soc) >=");
        expect(params).toContain(MIN_DISCHARGE_SOC_DROP);
        // No sample floor anywhere in the validity gate.
        const isValid = one.slice(one.indexOf("AS is_valid") - 260, one.indexOf("AS is_valid"));
        expect(isValid).not.toContain("n_samples >=");
    });

    it("namespaces its CTEs so it can be composed alongside the charge chain", () => {
        const one = flat(render(dischargeFor("BAT-1")).text);
        for (const cte of ["dis_flagged", "dis_grouped", "dis_anchored", "dis_bounded", "dis_cycled", "dis_stats", "dis_valid"]) {
            expect(one).toContain(`${cte} AS (`);
        }
    });
});

describe("deepDischargeCTEs", () => {
    it("is a Schmitt trigger, not a threshold", () => {
        const { text, params } = render(deepFor("BAT-1"));
        const one = flat(text);
        expect(one).toContain("CASE WHEN soc_pct <");
        expect(one).toContain("WHEN soc_pct >=");
        expect(params).toContain(DEEP_DISCHARGE_ENTER_PCT);
        expect(params).toContain(DEEP_DISCHARGE_EXIT_PCT);
        // The forward-fill that carries the state across the hysteresis band.
        expect(one).toContain("count(mark) OVER (ORDER BY time ROWS UNBOUNDED PRECEDING) AS grp");
        expect(one).toContain("first_value(mark) OVER (PARTITION BY grp ORDER BY time) AS state");
    });

    it("lifts LAG into its own CTE — Postgres will not nest window calls", () => {
        // This is a syntax error, not a slow query: SUM(... LAG(x) OVER ...) OVER () is
        // rejected outright with "window function calls cannot be nested", and it took a live
        // query against the real database to find that out.
        const one = flat(render(deepFor("BAT-1")).text);
        expect(one).toContain("LAG(state) OVER (ORDER BY time) AS prev_state");

        // The island counter must reference the pre-computed column, never call LAG itself.
        const islands = one.slice(
            one.indexOf("dd_islands AS ("),
            one.indexOf("dd_events AS ("),
        );
        expect(islands).toContain("CASE WHEN state = 1 AND COALESCE(prev_state, 0) = 0");
        expect(islands).not.toContain("LAG(");
    });

    it("reports the widest gap inside an event, so a duration can be disowned", () => {
        // The low SOC is a fact whatever the sampling. The event's DURATION is only a fact if
        // we were actually watching across it.
        expect(flat(render(deepFor("BAT-1")).text)).toContain("max(dt_s) AS max_gap_s");
    });
});
