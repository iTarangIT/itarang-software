/**
 * The single definition of what a *discharge* cycle is, and of a deep-discharge event.
 *
 * Composes sampleCTEs() from charging-sql.ts rather than restating the dedupe, the dsoc/dt
 * window and the trapezoid term — those are the same physics in both directions.
 * Everything after `stepped` is different, because charge and discharge are NOT symmetric.
 *
 * ## The three asymmetries
 *
 * | | Charge (cycleCTEs) | Discharge (here) | Why |
 * |---|---|---|---|
 * | session | `dsoc >= 0` | `dsoc <= 0` | direct mirror |
 * | trim start | last sample before the first *rise* | last sample before the first *fall* | direct mirror |
 * | trim end | last *rising* sample | last *falling* sample | direct mirror |
 * | **Ah accrual** | **every** interval in the cycle | **only** intervals where `dsoc < 0` | **NOT a mirror — see below** |
 *
 * ## Why Ah accrues only where SOC fell
 *
 * The charge chain accrues `ah_term` on every interval inside the cycle, including flat-SOC
 * ones, and that is correct there: SOC is quantised to whole percent, current keeps flowing
 * between ticks, and the intervals must tile the cycle exactly for the total to be an
 * integral. An interior pause contributes 0 A and therefore 0 Ah on its own.
 *
 * That rule does not transfer. A discharge session legitimately spans a drive, a park at flat
 * SOC, and the next drive — the cycle runs until the battery is recharged, so the park is
 * *inside* it. A parked vehicle is not drawing 40 A, but the last trip's current is what LAG
 * carries into that interval, so a naive mirror bills the park at the road's current.
 *
 * Measured on the reference battery over six months, that is worth **+2.9%** (3,554 Ah naive
 * against 3,455 Ah correct) — real, but far short of the order-of-magnitude error the rule was
 * first written to prevent. The reason it is not worse is the trim below: `cyc_last` is the
 * last *falling* sample, so the long overnight park at the bottom of a discharge already falls
 * outside the cycle. What this filter catches is the interior flats, which are short. Both
 * guards are needed; the trim is doing most of the work.
 *
 * The consequence to remember is structural, not numerical: because the intervals no longer
 * tile the cycle, coverage is not meaningful on the discharge side, and the coulomb total is a
 * partial integral by construction. That — plus the fact that discharge current swings 0-57 A
 * between samples — is why socDerivedAh is the primary series and this one is the cross-check.
 */
import type { IotSql, SqlFragment } from "./charging-sql";
import { sampleCTEs } from "./charging-sql";
import {
    DEEP_DISCHARGE_ENTER_PCT,
    DEEP_DISCHARGE_EXIT_PCT,
    MIN_DISCHARGE_SOC_DROP,
} from "./discharge-math";
import { SESSION_GAP_MAX_S } from "./charging-math";

/**
 * The discharge-cycle chain, ending at `dis_valid AS (…)` with no trailing SELECT.
 *
 * CTE names are prefixed `dis_` so this chain and the charge chain can be composed into one
 * query later (the timeline needs both) without colliding.
 */
export function dischargeCTEs(
    iot: IotSql,
    vehicleno: string,
    timePredicate: SqlFragment,
) {
    return iot`
        ${sampleCTEs(iot, vehicleno, timePredicate)},
        dis_flagged AS (
            SELECT *,
                -- SOC not rising = discharging or idle. A rise means the charger went on,
                -- and that ends the discharge. Mirrors the charge rule.
                CASE WHEN dsoc <= 0 AND dt_s IS NOT NULL AND dt_s <= ${SESSION_GAP_MAX_S}
                     THEN 1 ELSE 0 END AS in_sess
            FROM stepped
        ),
        dis_grouped AS (
            SELECT *,
                SUM(CASE WHEN in_sess = 0 THEN 1 ELSE 0 END) OVER (ORDER BY time) AS break_id
            FROM dis_flagged
        ),
        dis_anchored AS (
            SELECT *,
                min(time) FILTER (WHERE in_sess = 1 AND dsoc < 0)
                    OVER (PARTITION BY break_id) AS first_fall,
                max(time) FILTER (WHERE in_sess = 1 AND dsoc < 0)
                    OVER (PARTITION BY break_id) AS last_fall
            FROM dis_grouped
        ),
        dis_bounded AS (
            SELECT *,
                -- Anchor on the last sample before SOC first dropped, so start_soc is the
                -- pre-discharge SOC and the depth of discharge is the full swing.
                --
                -- NOT "the first sample carrying current", which is the charge side's old
                -- bug and would be worse here: a parked vehicle draws a quiescent current
                -- continuously, so a current-based anchor would start the discharge in the
                -- car park.
                COALESCE(
                    max(time) FILTER (WHERE in_sess = 1 AND time < first_fall)
                        OVER (PARTITION BY break_id),
                    first_fall
                ) AS cyc_first,
                last_fall AS cyc_last
            FROM dis_anchored
        ),
        dis_cycled AS (
            SELECT *,
                (in_sess = 1
                 AND cyc_first IS NOT NULL
                 AND cyc_last IS NOT NULL
                 AND time >= cyc_first
                 AND time <= cyc_last) AS in_cycle
            FROM dis_bounded
        ),
        dis_stats AS (
            SELECT
                break_id::int                                    AS break_id,
                min(time)                                        AS start_time,
                max(time)                                        AS end_time,
                EXTRACT(EPOCH FROM (max(time) - min(time)))::int AS duration_s,
                -- ONLY where SOC actually fell. Accruing across an interior flat stretch
                -- would bill a parked vehicle at the last trip's current (+2.9% on the
                -- reference battery — see the header for why it is not worse).
                sum(ah_term) FILTER (WHERE time > cyc_first AND dsoc < 0)
                                                                 AS ah_coulomb,
                (array_agg(soc_pct ORDER BY time))[1]            AS start_soc,
                (array_agg(soc_pct ORDER BY time DESC))[1]       AS end_soc,
                avg(pack_current) FILTER (WHERE dsoc < 0 AND pack_current > 0)
                                                                 AS avg_discharge_current,
                max(pack_current) FILTER (WHERE dsoc < 0)        AS max_discharge_current,
                min(soc_pct)                                     AS min_soc,
                count(*)::int                                    AS n_samples,
                count(*) FILTER (WHERE dsoc < 0)::int            AS n_falling_samples,
                max(rated_capacity_ah)                           AS rated_capacity_ah
            FROM dis_cycled
            WHERE in_cycle
            GROUP BY break_id
        ),
        dis_valid AS (
            SELECT *,
                -- DETECTION: did a discharge happen? Nothing about sampling density belongs
                -- here. The charge side put a sample floor in its detection gate and lost
                -- 70% of real events to it; the same mistake is available here and is not
                -- being made. See docs/intellicar-calculations.md §2.
                (
                    start_soc > end_soc
                    AND (start_soc - end_soc) >= ${MIN_DISCHARGE_SOC_DROP}
                ) AS is_valid
            FROM dis_stats
        )`;
}

/**
 * Deep-discharge events: a Schmitt trigger over the SOC series.
 *
 *     enter the state when SOC <  DEEP_DISCHARGE_ENTER_PCT   (20)
 *     leave the state when SOC >= DEEP_DISCHARGE_EXIT_PCT    (25)
 *
 * Between the two thresholds the state is *carried*, which is what makes one physical event
 * one row. A bare `SOC < 20` filter would count a battery wobbling across 19-21% as a new
 * event on every sample, and a battery parked at 12% for two days as dozens.
 *
 * Implemented as the standard last-non-null forward fill: mark the samples that decide the
 * state, count the marks so far to get a group anchor, then take the first mark in each
 * group — which is the state everything in that group inherits.
 */
export function deepDischargeCTEs(
    iot: IotSql,
    vehicleno: string,
    timePredicate: SqlFragment,
) {
    return iot`
        ${sampleCTEs(iot, vehicleno, timePredicate)},
        dd_marked AS (
            SELECT time, soc_pct, dt_s,
                CASE WHEN soc_pct <  ${DEEP_DISCHARGE_ENTER_PCT} THEN 1
                     WHEN soc_pct >= ${DEEP_DISCHARGE_EXIT_PCT}  THEN 0
                     ELSE NULL END AS mark
            FROM stepped
        ),
        dd_filled AS (
            SELECT *,
                count(mark) OVER (ORDER BY time ROWS UNBOUNDED PRECEDING) AS grp
            FROM dd_marked
        ),
        dd_state AS (
            SELECT *,
                -- NULL until the first decisive sample: a series that opens inside the
                -- 20-25% band has no state yet, and guessing one would invent an event.
                first_value(mark) OVER (PARTITION BY grp ORDER BY time) AS state
            FROM dd_filled
        ),
        dd_lagged AS (
            -- LAG lives in its own CTE: Postgres will not nest a window call inside another
            -- (SUM(... LAG(x) OVER ...) OVER ... is a syntax error, not a slow query).
            SELECT *, LAG(state) OVER (ORDER BY time) AS prev_state
            FROM dd_state
        ),
        dd_islands AS (
            SELECT *,
                SUM(
                    CASE WHEN state = 1 AND COALESCE(prev_state, 0) = 0
                         THEN 1 ELSE 0 END
                ) OVER (ORDER BY time) AS event_id
            FROM dd_lagged
        ),
        dd_events AS (
            SELECT
                event_id::int                                    AS event_id,
                min(time)                                        AS start_time,
                max(time)                                        AS end_time,
                EXTRACT(EPOCH FROM (max(time) - min(time)))::int AS duration_s,
                min(soc_pct)                                     AS min_soc,
                count(*)::int                                    AS n_samples,
                -- The widest telemetry gap inside the event. The low SOC is a fact whatever
                -- the sampling; the event's *duration* is only a fact if we were watching.
                max(dt_s)                                        AS max_gap_s
            FROM dd_islands
            WHERE state = 1
            GROUP BY event_id
        )`;
}
