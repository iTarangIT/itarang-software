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
import {
    COVERAGE_TRUST_GAP_S,
    MAX_VALID_CURRENT_A,
    MIN_CYCLE_DURATION_S,
    MIN_CYCLE_SAMPLES,
    MIN_CYCLE_SOC_GAIN,
    SESSION_GAP_MAX_S,
} from "./charging-math";

export type IotSql = ReturnType<typeof getIotSql>;
export type SqlFragment = ReturnType<IotSql>;

/** The period selector shared by every charging query and the export. */
export interface ChargingWindowOpts {
    months?: number;
    /** A specific calendar month, `YYYY-MM`. */
    month?: string;
    /** Custom range, `YYYY-MM-DD`. Both required; `to` is inclusive of that day. */
    from?: string;
    to?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Time window, in precedence order: an explicit custom range, then a specific
 * calendar month, then the rolling last N months (1 / 3 / 6).
 *
 * Every bound is half-open (`>= start AND < end`) so a sample landing exactly on
 * midnight is counted once, never in two adjacent windows. For a custom range that
 * means `to` is advanced by a day — a user picking 01→05 June expects the 5th
 * included, not truncated at its first instant.
 */
export function buildTimeWindow(iot: IotSql, opts: ChargingWindowOpts) {
    if (opts.from && opts.to && ISO_DATE.test(opts.from) && ISO_DATE.test(opts.to)) {
        const end = new Date(`${opts.to}T00:00:00Z`);
        end.setUTCDate(end.getUTCDate() + 1);
        const endExclusive = end.toISOString().slice(0, 10);
        return {
            timePredicate: iot`AND time >= ${opts.from} AND time < ${endExclusive}`,
            months: null as number | null,
            month: null as string | null,
            from: opts.from as string | null,
            to: opts.to as string | null,
        };
    }
    if (opts.month && /^\d{4}-\d{2}$/.test(opts.month)) {
        const [y, mo] = opts.month.split("-").map(Number);
        const start = `${opts.month}-01`;
        const next =
            mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
        return {
            timePredicate: iot`AND time >= ${start} AND time < ${`${next}-01`}`,
            months: null as number | null,
            month: opts.month as string | null,
            from: null as string | null,
            to: null as string | null,
        };
    }
    const months = [1, 3, 6, 12].includes(opts.months ?? 3) ? (opts.months ?? 3) : 3;
    return {
        timePredicate: iot`AND time > now() - (interval '1 month' * ${months})`,
        months: months as number | null,
        month: null as string | null,
        from: null as string | null,
        to: null as string | null,
    };
}

/**
 * The charging-cycle detection CTE chain, ending at `cycled AS (…)` with no
 * trailing SELECT — a caller appends either `SELECT …` or `, more_cte AS (…) SELECT …`.
 *
 * Returns a *fresh* fragment per call. postgres.js `Query extends Promise` and
 * `fragment()` mutates `q.fragment`, so a cached instance would risk accidental
 * execution and cross-query interference.
 *
 * ## The rules
 *
 * **Dedupe first.** ~96% of telemetry_can rows repeat a timestamp — the AWS poller
 * re-inserts the latest CAN frame on every poll whether or not the device has
 * produced a new one. Without DISTINCT ON, `time - LAG(time)` is 0 across every
 * duplicate, so those samples contribute no Ah at all, and `LAG` over tied
 * timestamps picks an arbitrary row, making dsoc unstable between identical runs.
 * DISTINCT ON (time) collapses each device sample to one row and makes the window
 * deterministic. (This is a read-side workaround: the poller is Python on AWS and
 * outside this repo. Fixing it there is the real win — at ~100 distinct samples
 * per battery per day against a ~30 s device stream, we are integrating a current
 * curve we can barely see.)
 *
 * **Session.** The VPS `charging` boolean is never populated, so charging is
 * inferred from rising SOC: a sample joins the current session when SOC did not
 * fall and the gap since the previous sample is at most SESSION_GAP_MAX_S.
 * `break_id` counts the breaks before each row, which groups the contiguous runs.
 *
 * Note that pack current cannot identify charging on its own: the BMS reports an
 * unsigned magnitude, and discharge current (to ~57 A) runs *higher* than charge
 * current (~21 A). Current > 0 is a necessary condition, not a sufficient one.
 *
 * **Boundaries.** A session's leading and trailing idle samples are not charging —
 * the battery sat at a flat SOC before the charger was plugged in, and sat at 100%
 * after it finished. The cycle is trimmed to start at the first sample carrying
 * current and to end at the last sample where SOC still rose. Interior zero-current
 * stretches (the charger pausing mid-charge) stay *inside* the cycle: they
 * contribute no Ah but they must not split it in two.
 *
 * Battery telemetry lives in telemetry_can as a JSONB `payload`. Payload keys of
 * interest:
 *   payload->'soc'->>'value'             integer %  (0..100)
 *   payload->'current'->>'value'         pack current in A (unsigned magnitude)
 *   payload->'battery_voltage'->>'value' pack voltage in V (export only)
 *   payload->'rated_capacity'->>'value'  nameplate Ah — the plausibility check
 */
/**
 * The shared prefix of every per-battery telemetry query: `raw` → `samples` → `stepped`.
 *
 * Opens the WITH chain and ends WITHOUT a trailing comma, so a caller appends
 * `, next_cte AS (…)`. Charging (cycleCTEs) and discharging (dischargeCTEs) both build on
 * this, which is the point: the dedupe, the `dsoc` / `dt_s` window and the trapezoid term
 * are the same physics in both directions, and a second copy of them would be a second
 * thing to keep correct.
 *
 * Everything downstream of `stepped` differs, because charge and discharge are not
 * symmetric — see dischargeCTEs for the three asymmetries.
 */
export function sampleCTEs(
    iot: IotSql,
    vehicleno: string,
    timePredicate: SqlFragment,
) {
    return iot`
        WITH raw AS (
            SELECT DISTINCT ON (time)
                time,
                (payload->'soc'->>'value')::float             AS soc_pct,
                (payload->'current'->>'value')::float         AS pack_current,
                (payload->'battery_voltage'->>'value')::float AS pack_voltage,
                (payload->'rated_capacity'->>'value')::float  AS rated_capacity_ah
            FROM telemetry_can
            WHERE vehicleno = ${vehicleno}
              AND payload->'soc'->>'value' IS NOT NULL
              -- Reject corrupt CAN frames rather than integrating them. A current in
              -- the hundreds is a decode fault on a pack that peaks near 57 A, and it
              -- would silently inflate the AH total. A missing reading is not corrupt,
              -- so it stays.
              AND (
                payload->'current'->>'value' IS NULL
                OR ABS((payload->'current'->>'value')::float) <= ${MAX_VALID_CURRENT_A}
              )
              ${timePredicate}
            ORDER BY time
        ),
        samples AS (
            SELECT
                time,
                soc_pct,
                pack_current,
                pack_voltage,
                rated_capacity_ah,
                soc_pct - LAG(soc_pct) OVER w                 AS dsoc,
                LAG(pack_current) OVER w                      AS prev_current,
                EXTRACT(EPOCH FROM (time - LAG(time) OVER w)) AS dt_s
            FROM raw
            WINDOW w AS (ORDER BY time)
        ),
        stepped AS (
            SELECT *,
                -- Trapezoid: mean of the interval's two current readings x its real
                -- duration. Mirrors ahIncrement() in charging-math.ts.
                CASE WHEN dt_s IS NOT NULL AND dt_s > 0 AND pack_current IS NOT NULL
                     THEN ((ABS(pack_current) + ABS(COALESCE(prev_current, pack_current))) / 2.0)
                          * (dt_s / 3600.0)
                     ELSE 0 END AS ah_term
            FROM samples
        )`;
}

export function cycleCTEs(
    iot: IotSql,
    vehicleno: string,
    timePredicate: SqlFragment,
) {
    return iot`
        ${sampleCTEs(iot, vehicleno, timePredicate)},
        flagged AS (
            SELECT *,
                CASE WHEN dsoc >= 0 AND dt_s IS NOT NULL AND dt_s <= ${SESSION_GAP_MAX_S}
                     THEN 1 ELSE 0 END AS in_sess
            FROM stepped
        ),
        grouped AS (
            SELECT *,
                SUM(CASE WHEN in_sess = 0 THEN 1 ELSE 0 END) OVER (ORDER BY time) AS break_id
            FROM flagged
        ),
        anchored AS (
            SELECT *,
                min(time) FILTER (WHERE in_sess = 1 AND dsoc > 0)
                    OVER (PARTITION BY break_id) AS first_rise,
                max(time) FILTER (WHERE in_sess = 1 AND dsoc > 0)
                    OVER (PARTITION BY break_id) AS last_rise
            FROM grouped
        ),
        bounded AS (
            SELECT *,
                -- Charging begins at the last sample *before* SOC first ticked up, and
                -- ends at the last sample where SOC still rose.
                --
                -- The start anchor used to be the first sample carrying current, which
                -- truncated real charges. Pack current is an unsigned magnitude and it
                -- is often absent or zero over the opening samples of a charge, so the
                -- cycle began late and its start_soc was read part-way up the ramp: on
                -- the reference battery, a 50% -> 100% charge was recorded as 59% ->
                -- 100%, losing 9 points of the swing that the capacity extrapolation
                -- divides by. Anchoring on the sample that *preceded* the first genuine
                -- SOC tick keeps start_soc at the pre-charge SOC, and keeps the excluded
                -- first interval the one that reaches back into idle.
                --
                -- Ending on the last *rising* sample rather than the last sample carrying
                -- current is deliberate: it keeps the CV taper (where current falls to 0
                -- as SOC reaches 100) inside the cycle, while still excluding the long
                -- idle stretch that follows at a flat 100%.
                COALESCE(
                    max(time) FILTER (WHERE in_sess = 1 AND time < first_rise)
                        OVER (PARTITION BY break_id),
                    first_rise
                ) AS cyc_first,
                last_rise AS cyc_last
            FROM anchored
        ),
        cycled AS (
            SELECT *,
                (in_sess = 1
                 AND cyc_first IS NOT NULL
                 AND cyc_last IS NOT NULL
                 AND time >= cyc_first
                 AND time <= cyc_last) AS in_cycle
            FROM bounded
        ),
        cycle_stats AS (
            SELECT
                break_id::int                                                AS break_id,
                min(time)                                                    AS start_time,
                max(time)                                                    AS end_time,
                EXTRACT(EPOCH FROM (max(time) - min(time)))::int             AS duration_s,
                -- The first in-cycle sample's interval reaches back into the idle
                -- period before the charger was plugged in, so it is excluded. The
                -- remaining intervals tile [start_time, end_time] exactly, which is
                -- what makes ah_charged an integral over the charge and lets
                -- coverage_pct be read against duration_s.
                sum(ah_term) FILTER (WHERE time > cyc_first)                 AS ah_charged,
                (array_agg(soc_pct ORDER BY time))[1]                        AS start_soc,
                (array_agg(soc_pct ORDER BY time DESC))[1]                   AS end_soc,
                avg(pack_current) FILTER (WHERE pack_current > 0)            AS avg_charging_current,
                max(pack_current)                                            AS max_charging_current,
                sum(dt_s) FILTER (
                    WHERE time > cyc_first AND dt_s <= ${COVERAGE_TRUST_GAP_S}
                )                                                            AS covered_s,
                count(*)::int                                                AS n_samples,
                count(*) FILTER (WHERE pack_current > 0)::int                AS n_current_samples,
                -- The widest silence inside the charge. Reported so a reader can see whether the
                -- Ah integral leans on a long stretch of interpolated current. Bounded by
                -- SESSION_GAP_MAX_S by construction — a wider gap would have ended the session.
                max(dt_s) FILTER (WHERE time > cyc_first)                    AS max_gap_s,
                max(rated_capacity_ah)                                       AS rated_capacity_ah
            FROM cycled
            WHERE in_cycle
            GROUP BY break_id
        ),
        cycle_valid AS (
            SELECT *,
                round(
                    (COALESCE(covered_s, 0) / NULLIF(duration_s, 0) * 100)::numeric, 1
                )::float AS coverage_pct,
                -- DETECTION: did a charge physically happen?
                --
                -- Four questions, all of them about physics, none of them about how *big* the
                -- charge was or how well we happened to sample it:
                --
                --   SOC rose                  something went in
                --   Ah flowed                 the integral is positive
                --   current was seen          the BMS actually reported a charge current
                --   it lasted MIN_CYCLE_DURATION_S   a 1% tick over two minutes is a BMS
                --                             re-estimate; twenty minutes carrying current is a
                --                             driver topping up
                --
                -- **A small charge is still a charge.** The old rule rejected any cycle gaining
                -- under 5% SOC, and a sample floor rejected any cycle the poller stored fewer
                -- than 5 times — between them they deleted real charges from the count, from
                -- Total Ah and from Avg Duration. Both are gone from this gate. What replaces
                -- them is not a looser threshold but a *different question*: detection asks
                -- whether it happened, and capacityConfidence() (charging-math.ts) grades how far
                -- the resulting numbers can be trusted.
                --
                -- Rejecting a cycle and distrusting one are different facts. The reader is owed
                -- the difference.
                (
                    end_soc > start_soc
                    AND COALESCE(ah_charged, 0) > 0
                    AND n_current_samples > 0
                    AND COALESCE(duration_s, 0) >= ${MIN_CYCLE_DURATION_S}
                ) AS is_valid,
                -- Reported, not enforced. Feeds the confidence grade; a cycle below it is still
                -- counted, and still carries a capacity estimate — graded low.
                --
                -- Keep OUT of is_valid: fetchChargingCycleDetail's in_valid_cycle and the Excel
                -- export's anti-drift guard both key off is_valid, and pointing either at this
                -- would fire the guard and 500 every export.
                (n_samples >= ${MIN_CYCLE_SAMPLES}) AS enough_samples,
                -- A top-up rather than a full charge. Worth saying on the row; not worth
                -- deleting the row over.
                ((end_soc - start_soc) < ${MIN_CYCLE_SOC_GAIN}) AS is_topup
            FROM cycle_stats
        )`;
}

/**
 * Pre-flight sample count for the export cap.
 *
 * Counts `raw` — the deduped, current-validated set the export's rows actually come
 * from — rather than restating its filter. The previous hand-written count claimed in
 * its own comment to "mirror the raw CTE exactly" and mirrored neither DISTINCT ON nor
 * the current bound, so it counted duplicate timestamps: on the reference battery that
 * is 7,109 rows against 2,331 real samples, a 3x overstatement, and the 100k export cap
 * then rejected windows that would have exported fine.
 *
 * Postgres does not evaluate unreferenced CTEs, so selecting from `raw` alone costs the
 * dedupe scan and nothing else. Building it from cycleCTEs rather than beside it is what
 * makes the two structurally incapable of drifting apart again.
 */
export function countSamplesQuery(
    iot: IotSql,
    vehicleno: string,
    timePredicate: SqlFragment,
) {
    return iot`
        ${cycleCTEs(iot, vehicleno, timePredicate)}
        SELECT count(*)::int AS n FROM raw
    `;
}
