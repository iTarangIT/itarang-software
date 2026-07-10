/**
 * The single definition of what a charging cycle *is*.
 *
 * Both the dashboard aggregate (fetchChargingCycleAggregate) and the per-sample
 * export detail (fetchChargingCycleDetail) build their queries on the fragment
 * below, so the Charging Analysis workbook can never disagree with the numbers
 * on screen. Change the rules here and both move together.
 *
 * Kept apart from queries.ts so it can be unit-tested without pulling in the DB
 * clients: the builders take the postgres.js tagged template as an argument
 * rather than reaching for getIotSql() themselves.
 */
import type { getIotSql } from "@/lib/db/iot";

export type IotSql = ReturnType<typeof getIotSql>;
export type SqlFragment = ReturnType<IotSql>;

/**
 * Time window: a specific calendar month (YYYY-MM) when `month` is given,
 * otherwise the last N months relative to now (1 / 3 / 6).
 */
export function buildTimeWindow(
    iot: IotSql,
    opts: { months?: number; month?: string },
) {
    if (opts.month && /^\d{4}-\d{2}$/.test(opts.month)) {
        const [y, mo] = opts.month.split("-").map(Number);
        const start = `${opts.month}-01`;
        const next =
            mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
        return {
            timePredicate: iot`AND time >= ${start} AND time < ${`${next}-01`}`,
            months: null as number | null,
            month: opts.month as string | null,
        };
    }
    const months = [1, 3, 6].includes(opts.months ?? 3) ? (opts.months ?? 3) : 3;
    return {
        timePredicate: iot`AND time > now() - (interval '1 month' * ${months})`,
        months: months as number | null,
        month: null as string | null,
    };
}

/**
 * The charging-cycle detection CTE chain, ending at `grouped AS (…)` with no
 * trailing SELECT — a caller appends either `SELECT …` or `, more_cte AS (…) SELECT …`.
 *
 * Returns a *fresh* fragment per call. postgres.js `Query extends Promise` and
 * `fragment()` mutates `q.fragment`, so a cached instance would risk accidental
 * execution and cross-query interference.
 *
 * The VPS `charging` boolean is never populated, so charging is inferred from
 * rising SOC: a sample joins the current session when SOC did not fall and the
 * gap since the previous sample is at most 20 minutes. `break_id` counts the
 * breaks before each row, which groups the contiguous in-session runs.
 *
 * Battery telemetry lives in telemetry_can as a JSONB `payload` — the AWS poller
 * writes SOC / current / voltage there, NOT into the legacy telemetry_battery
 * table (frozen at the VPS-migration cutover). Payload keys of interest:
 *   payload->'soc'->>'value'             integer %  (0..100)
 *   payload->'current'->>'value'         pack current in A (sign varies; ABS used)
 *   payload->'battery_voltage'->>'value' pack voltage in V (export only)
 */
export function cycleCTEs(
    iot: IotSql,
    vehicleno: string,
    timePredicate: SqlFragment,
) {
    return iot`
        WITH raw AS (
            SELECT
                time,
                (payload->'soc'->>'value')::float             AS soc_pct,
                (payload->'current'->>'value')::float         AS pack_current,
                (payload->'battery_voltage'->>'value')::float AS pack_voltage
            FROM telemetry_can
            WHERE vehicleno = ${vehicleno}
              AND payload->'soc'->>'value' IS NOT NULL
              ${timePredicate}
        ),
        samples AS (
            SELECT
                time,
                soc_pct,
                pack_current,
                pack_voltage,
                soc_pct - LAG(soc_pct) OVER w                          AS dsoc,
                EXTRACT(EPOCH FROM (time - LAG(time) OVER w))          AS dt_s
            FROM raw
            WINDOW w AS (ORDER BY time)
        ),
        flagged AS (
            SELECT *,
                CASE WHEN dsoc >= 0 AND dt_s IS NOT NULL AND dt_s <= 1200 THEN 1 ELSE 0 END AS in_sess
            FROM samples
        ),
        grouped AS (
            SELECT *,
                SUM(CASE WHEN in_sess = 0 THEN 1 ELSE 0 END) OVER (ORDER BY time) AS break_id
            FROM flagged
        )`;
}
