/**
 * Is the BMS State-of-Health feed telling us anything?
 *
 * Pure — no DB imports, so the API route, the tests and client code can all share one
 * answer (same rule as thresholds-math.ts / load-math.ts).
 *
 * ## Why this exists
 *
 * `telemetry_battery.soh_pct` and `vehicle_state.soh_pct` are *reported* numbers, not
 * measured ones. On this fleet they read **exactly 100.0 on all 297 packs that report at
 * all** (13 null), and the feed behind them is stale by hours. A degradation chart drawn
 * from that is a flat line at 100, and "0 devices below 80%" is not a clean bill of
 * health — it is a dead sensor. A CEO reading either one is being told the fleet is
 * perfect by a number that is incapable of saying anything else.
 *
 * The fix is not to hardcode "the feed is dead" — that would be its own lie the day the
 * poller starts writing real values. It is to **detect the constancy** and say so. A
 * series with no variation is not a measurement, whatever it reports; a series that
 * varies is, and it charts normally with no code change.
 *
 * ## What this is NOT
 *
 * This does not measure capacity. Measured SOH comes from `extrapolateCapacity()` over a
 * detected charging cycle, as a fraction of the pack's own nameplate — see
 * charging-math.ts and CapacityDegradationChart, which already do exactly that per pack.
 * Rolling that up across the fleet needs cycle detection per vehicle, which the
 * per-vehicle CTEs in charging-sql.ts cannot do in one query. Until that exists, the
 * honest answer for the fleet is "unmeasured", not a number.
 */

/** One day of the fleet SOH trend, as `fetchSOHTrend` returns it. */
export interface SohTrendPoint {
    avg_soh: number | null;
    min_soh: number | null;
    max_soh: number | null;
}

/**
 * What the SOH feed is worth.
 *
 * `constant` and `empty` are different facts and the reader is owed the difference: an
 * empty feed says nobody reported, a constant one says everybody reported the same
 * impossible number. Only the first is a gap; the second is a broken instrument.
 */
export type SohFeedVerdict =
    /** The series varies — it is measuring something. Chart it. */
    | { kind: "informative" }
    /**
     * Every pack, every day, reports the identical value. Across hundreds of packs of
     * different ages that cannot happen to a real measurement, so the number describes
     * the firmware's default, not the battery.
     */
    | { kind: "constant"; value: number; days: number }
    /** No pack reported an SOH in the window at all. */
    | { kind: "empty" };

/**
 * Classify the fleet SOH series.
 *
 * Reads min and max rather than the daily average, because the average of a constant is
 * a constant and would hide a fleet whose packs disagree wildly on any single day. If
 * every min and every max across the whole window collapse to one value, then no pack
 * differed from any other pack on any day — a spread of exactly zero across ~300 packs
 * over weeks. That is a stuck signal, not a healthy fleet.
 */
export function classifySohFeed(rows: readonly SohTrendPoint[]): SohFeedVerdict {
    const usable = rows.filter(
        (r) =>
            r.min_soh != null &&
            r.max_soh != null &&
            Number.isFinite(r.min_soh) &&
            Number.isFinite(r.max_soh),
    );
    if (usable.length === 0) return { kind: "empty" };

    const values = new Set<number>();
    for (const r of usable) {
        values.add(r.min_soh as number);
        values.add(r.max_soh as number);
    }
    if (values.size === 1) {
        return { kind: "constant", value: [...values][0], days: usable.length };
    }
    return { kind: "informative" };
}

/** How the `soh_pct < 80` warranty test actually fared across the fleet. */
export interface WarrantyAssessment {
    /** Packs carrying a non-null SOH — the only ones the `< 80` test could even run on. */
    assessed: number;
    /**
     * Packs reporting no SOH at all. **Not healthy — unmeasured.** Counting these as
     * passing is how "0 at-risk" gets manufactured from silence.
     */
    unassessable: number;
    /** Every assessed pack reports the same value ⇒ the test can never fire. */
    constantFeed: boolean;
    /** The value they all report, when constantFeed. */
    constantValue: number | null;
}

/**
 * Can the fleet's warranty risk be assessed at all?
 *
 * `distinctValues` is the count of distinct non-null SOH readings across the fleet. One
 * distinct value means every pack agrees exactly — so `soh_pct < 80` returns the same
 * answer for all of them forever, and a zero count carries no information.
 */
export function assessWarrantyFeed(
    assessed: number,
    unassessable: number,
    distinctValues: readonly number[],
): WarrantyAssessment {
    const constantFeed = assessed > 0 && distinctValues.length === 1;
    return {
        assessed,
        unassessable,
        constantFeed,
        constantValue: constantFeed ? distinctValues[0] : null,
    };
}
