/**
 * Discharge is not the mirror image of charge, and treating it as one produces numbers
 * that are wrong by an order of magnitude. This file is where the asymmetries live.
 *
 * The pure half — constants, gates, and the two ways of measuring Ah out — so vitest can
 * cover them without a database, exactly as charging-math.ts does for the charge side.
 */

function envNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw == null || raw.trim() === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Minimum SOC drop before a discharge run is reported as a cycle.
 *
 * Mirrors MIN_CYCLE_SOC_GAIN on the charge side and for the same reason: below this it is
 * a blip, not a discharge. A vehicle sitting idle bleeds a percent or two a day.
 */
export const MIN_DISCHARGE_SOC_DROP = envNumber("TELEMETRY_MIN_DISCHARGE_SOC_DROP", 5);

/**
 * Fewest samples a discharge may have before its *coulomb* integral is trusted.
 *
 * This gates the coulomb series ONLY — never detection. The charge side learned this the
 * hard way: a sample floor in the detection gate deleted 70% of real charges from the
 * count, because the poller stores a 45-minute event as 2-4 rows. A sparsely-sampled
 * discharge is still a discharge, and its SOC-derived Ah (below) survives sparsity anyway.
 */
export const MIN_DISCHARGE_SAMPLES = envNumber("TELEMETRY_MIN_DISCHARGE_SAMPLES", 5);

/**
 * Deep discharge is a Schmitt trigger, not a threshold: enter below ENTER, leave only
 * above EXIT.
 *
 * A bare `SOC < 20` test counts a battery hovering at 19-21% as a new event on every
 * wobble, and a battery that sits at 12% for two days as dozens. The 5pp hysteresis band
 * makes one physical event one event. ENTER is the number the business cares about (20%);
 * EXIT exists only to debounce it.
 */
export const DEEP_DISCHARGE_ENTER_PCT = envNumber("TELEMETRY_DEEP_DISCHARGE_ENTER_PCT", 20);
export const DEEP_DISCHARGE_EXIT_PCT = envNumber("TELEMETRY_DEEP_DISCHARGE_EXIT_PCT", 25);

/** The active gates, so the UI can explain what it counted and why. */
export function dischargeGates() {
    return {
        minSocDrop: MIN_DISCHARGE_SOC_DROP,
        minSamples: MIN_DISCHARGE_SAMPLES,
        deepEnterPct: DEEP_DISCHARGE_ENTER_PCT,
        deepExitPct: DEEP_DISCHARGE_EXIT_PCT,
    };
}

/**
 * Ah out, from the SOC endpoints. **This is the primary series.**
 *
 *     Ah = (startSOC − endSOC) / 100 × ratedCapacity
 *
 * SOC is a *state*, not a rate, so this needs only the two endpoints and degrades
 * gracefully as the poller gets sparser. The coulomb integral does not: discharge current
 * swings between 0 and ~57 A with traffic and stop-starts, so interpolating it across a
 * 33-minute telemetry gap (our p90) is not a measurement, it is a straight line drawn
 * through a curve nobody saw. On charge the interpolation is defensible because current is
 * genuinely steady through the CC phase; on discharge it is not.
 *
 * The cost is that this inherits the BMS's own SOC estimate, drift and all. That is a
 * known, bounded error. The coulomb integral's error under sparse sampling is neither.
 */
export function socDerivedAh(
    startSoc: number | null,
    endSoc: number | null,
    ratedAh: number | null,
): number | null {
    if (startSoc == null || endSoc == null || ratedAh == null || ratedAh <= 0) return null;
    const drop = startSoc - endSoc;
    if (drop <= 0) return null;
    return Math.round((drop / 100) * ratedAh * 100) / 100;
}

/** How deep the discharge went, in SOC points. */
export function depthOfDischarge(
    startSoc: number | null,
    endSoc: number | null,
): number | null {
    if (startSoc == null || endSoc == null) return null;
    const drop = startSoc - endSoc;
    return drop > 0 ? Math.round(drop * 10) / 10 : null;
}

/**
 * How far the coulomb integral has drifted from the SOC-derived figure, as a percentage of
 * the SOC-derived one.
 *
 * This is the honest diagnostic on the discharge page. The two methods measure the same
 * quantity by independent routes, so where they agree, both are probably right; where they
 * diverge, the telemetry is too sparse to integrate and the coulomb number should not be
 * believed. Surfacing the gap is better than silently picking a winner.
 */
export function dischargeDivergencePct(
    socAh: number | null,
    coulombAh: number | null,
): number | null {
    if (socAh == null || coulombAh == null || socAh <= 0) return null;
    return Math.round(((coulombAh - socAh) / socAh) * 1000) / 10;
}

/**
 * Energy efficiency over a day: Ah drawn per kilometre driven.
 *
 * Daily, not per-cycle, and deliberately so. Distance arrives only as a daily rollup
 * (`distance_rollup`, bucket_size='day') — the per-trip `trips` table is empty fleet-wide —
 * so attributing a day's kilometres to one of several discharge cycles within that day
 * would be an invention, not a measurement. The day is the finest honest unit.
 */
export function ahPerKm(ahDischarged: number | null, km: number | null): number | null {
    if (ahDischarged == null || km == null || km <= 0) return null;
    return Math.round((ahDischarged / km) * 1000) / 1000;
}
