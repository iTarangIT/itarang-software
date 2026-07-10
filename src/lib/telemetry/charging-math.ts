/**
 * Pure charging-cycle arithmetic. No I/O, no imports — so both the SQL-backed
 * queries and the Excel export can share one definition, and vitest can cover it.
 *
 * The authoritative per-cycle totals are computed in SQL (see
 * fetchChargingCycleAggregate). What lives here is the capacity rule, which SQL
 * never applied, and the single-step AH term, which the export re-derives for
 * display so an engineer can see the integration term by term.
 */

/** The interval-ending fields of one telemetry sample. */
export interface AhStep {
    /** SOC change over the interval ending at this sample. */
    dsoc: number | null;
    /** Seconds since the previous sample. */
    dt_s: number | null;
    /** Pack current in amps; sign convention varies, so magnitude is used. */
    pack_current: number | null;
}

/** Below this measured SOC swing the extrapolation to 100% amplifies noise too much. */
export const CAPACITY_SOC_THRESHOLD = 50;

/**
 * Extrapolate full (100%) capacity from the AH added over the measured SOC gain:
 *   capacity = ah / (ΔSOC/100)
 *
 * Only trusted when the coulomb-counted current spans a large swing. A 5% top-up
 * extrapolated ×20 amplifies noise; a ≥50% swing is at most a ×2 extrapolation.
 * Cycles below the threshold still appear in the AH trend but yield no capacity.
 */
export function extrapolateCapacity(
    ahCharged: number,
    socMeasured: number | null,
): number | null {
    return socMeasured != null && socMeasured >= CAPACITY_SOC_THRESHOLD
        ? Math.round((ahCharged / (socMeasured / 100)) * 10) / 10
        : null;
}

/**
 * AH added over the interval ending at this sample. Mirrors the SQL term:
 *   dsoc > 0 AND pack_current IS NOT NULL ? |current| * dt_s/3600 : 0
 *
 * Display only. A cycle's total always comes from the aggregate row — re-summing
 * these in JS drifts from Postgres's rounding and summation.
 */
export function ahIncrement(step: AhStep): number {
    const { dsoc, dt_s, pack_current } = step;
    if (dsoc == null || dsoc <= 0 || pack_current == null || dt_s == null) return 0;
    return Math.abs(pack_current) * (dt_s / 3600);
}
