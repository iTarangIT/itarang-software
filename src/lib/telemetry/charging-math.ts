/**
 * Pure charging-cycle arithmetic. No I/O, no imports — so both the SQL-backed
 * queries and the Excel export can share one definition, and vitest can cover it.
 *
 * The authoritative per-cycle totals are computed in SQL (see
 * fetchChargingCycleAggregate). What lives here is the capacity rule, the
 * trust/coverage rules, and the single-step AH term, which the export re-derives
 * for display so an engineer can see the integration term by term.
 *
 * ## Why the AH term looks the way it does
 *
 * Coulomb counting is an integral: Ah = ∫|I| dt. It is only as good as the time
 * axis you feed it, and both of the prior definitions of that axis were wrong.
 *
 *  - The vendor's `CAN Data.xlsx` multiplies each sample's current by a *nominal*
 *    packet interval (~30 s) carried in its own column. That column is not the
 *    spacing between the rows in the dump — the dump is subsampled ~5x, and the
 *    column matches the real timestamp delta in 7 of 5,222 rows. Summed over the
 *    reference cycle it accounts for 3,060 s of a 16,380 s charge: 18.7% of the
 *    elapsed time. Hence its 14.64 Ah → 19.26 Ah "capacity" for a battery whose
 *    BMS reports a 105 Ah nameplate at SOH 100%. Integrating the same rows over
 *    their real timestamps yields 71.4 Ah → 94.0 Ah, which is physically sane
 *    (the shortfall from nameplate is CV-taper at the top of the charge).
 *
 *  - Our own earlier SQL derived dt from `time - LAG(time)` but never deduped, and
 *    ~96% of telemetry_can rows repeat a timestamp (the poller re-inserts unchanged
 *    samples). Every duplicate got dt = 0 and contributed nothing.
 *
 * So: dedupe by timestamp (in SQL), integrate over the *actual* elapsed interval,
 * and accrue on every sample in the cycle — not only the ones where SOC ticked up,
 * since SOC is quantised to whole percent and current flows between ticks.
 */

/** The interval-ending fields of one telemetry sample. */
export interface AhStep {
    /** Seconds since the previous sample. */
    dt_s: number | null;
    /** Pack current in amps; the BMS reports an unsigned magnitude. */
    pack_current: number | null;
    /** Pack current at the previous sample — the other end of the trapezoid. */
    prev_current: number | null;
}

/**
 * A gap longer than this ends the charging session. Sized to the real sample
 * cadence of telemetry_can (median 510 s, p90 ~2,010 s, max ~3,900 s), not to the
 * device's nominal 30 s stream. The previous value of 1200 s split genuine
 * sessions in half, because it sat below the p90 gap between stored samples.
 */
export const SESSION_GAP_MAX_S = 3600;

/**
 * An interval longer than this is not evidence, it is a guess: we are interpolating
 * current across the whole gap from its two endpoints. Such intervals still accrue
 * Ah (the time really did elapse) but they do not count toward a cycle's coverage.
 *
 * 20 minutes against a nominal 30 s device stream: a gap that long is a telemetry
 * dropout, but current during constant-current charging is genuinely steady, so
 * interpolating across it is defensible. Beyond that it is not. For reference, the
 * worst gap inside the reference cycle in `docs/intellicar/CAN Data.xlsx` is 960 s.
 */
export const COVERAGE_TRUST_GAP_S = 1200;

function envNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw == null || raw.trim() === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Minimum SOC swing before a cycle's capacity may be extrapolated to 100%.
 *
 * The extrapolation divides by ΔSOC/100, so it multiplies whatever error is in the
 * Ah total by 100/ΔSOC. At a 5% swing that is ×20 — and measured against this fleet's
 * real data, dropping the gate to 0 produces a **191 Ah estimate on a 105 Ah pack**.
 * At 20% the amplification is ×5 and every estimate lands in a credible band
 * (76–126 Ah, mean 103.9 against a 105 Ah nameplate over 6 months).
 *
 * 20 rather than 50 because 50 was throwing away almost everything: of 34 detected
 * cycles, only 2 cleared a 50% swing. Override with TELEMETRY_MIN_SOC_DIFFERENCE.
 */
export const CAPACITY_SOC_THRESHOLD = envNumber("TELEMETRY_MIN_SOC_DIFFERENCE", 20);

/**
 * Minimum data coverage before a capacity is extrapolated. **Off by default.**
 *
 * Coverage turned out to be nearly redundant once the SOC gate is sane: at a 20%
 * swing, no cycle produces an implausible estimate regardless of coverage, while a
 * 70% coverage floor cut 13 usable cycles down to 2. So it is reported as a
 * confidence signal on every point rather than used to silently drop cycles.
 * Raise it with TELEMETRY_MIN_COVERAGE_PCT if the poller is ever fixed and dense
 * data makes a stricter floor affordable.
 */
export const MIN_COVERAGE_PCT = envNumber("TELEMETRY_MIN_COVERAGE_PCT", 0);

/**
 * Fewest samples a cycle may have and still be coulomb-counted. Two samples describe
 * a single interval — one straight line through a whole charge — which is not an
 * integral, it is a guess with a slope.
 */
export const MIN_CYCLE_SAMPLES = envNumber("TELEMETRY_MIN_CYCLE_SAMPLES", 5);

/** A cycle smaller than this is a top-up, not a charge worth reporting. */
export const MIN_CYCLE_SOC_GAIN = envNumber("TELEMETRY_MIN_CYCLE_SOC_GAIN", 5);

/**
 * Pack current above this is a corrupt CAN frame, not a reading. The fleet's packs
 * are 105 Ah and peak near 57 A; a value in the hundreds is a decode fault, and left
 * in it would silently inflate the Ah integral.
 */
export const MAX_VALID_CURRENT_A = envNumber("TELEMETRY_MAX_VALID_CURRENT_A", 500);

/** The active gate settings, so the UI can explain what it filtered and why. */
export function capacityGates() {
    return {
        minSocDifference: CAPACITY_SOC_THRESHOLD,
        minCoveragePct: MIN_COVERAGE_PCT,
        minSamples: MIN_CYCLE_SAMPLES,
    };
}

/**
 * AH added over the interval *ending* at this sample, by the trapezoid rule:
 *
 *     (|I_prev| + |I_now|) / 2  ×  dt / 3600
 *
 * Trapezoidal rather than rectangular because at our sample spacing (8.5 min
 * median) a rectangle holds one endpoint's current across the entire interval,
 * which systematically mis-states a ramping or tapering charge.
 *
 * Accrues on *every* sample in the cycle, including flat-SOC rows and the interior
 * zero-current pauses — a pause contributes 0 A and therefore 0 Ah on its own, but
 * it must not be skipped, because the intervals have to tile the cycle exactly for
 * the total to be an integral over the charge.
 *
 * Display only. A cycle's total always comes from the aggregate row — re-summing
 * these in JS drifts from Postgres's rounding and summation.
 */
export function ahIncrement(step: AhStep): number {
    const { dt_s, pack_current, prev_current } = step;
    if (dt_s == null || dt_s <= 0 || pack_current == null) return 0;
    const now = Math.abs(pack_current);
    // No previous reading (first sample of the window): fall back to a rectangle.
    const prev = prev_current != null ? Math.abs(prev_current) : now;
    return ((prev + now) / 2) * (dt_s / 3600);
}

/**
 * Extrapolate full (100%) capacity from the AH added over the cycle's SOC swing:
 *
 *     capacity = Ah ÷ (ΔSOC / 100)        where ΔSOC = endSOC − startSOC
 *
 * Declines to estimate only when the arithmetic itself would not survive it — a wrong
 * number here is worse than no number, because it lands on a battery-health chart and
 * gets believed. The division amplifies the Ah total's error by 100/ΔSOC, so below
 * CAPACITY_SOC_THRESHOLD the result is noise wearing a decimal point.
 *
 * Coverage is a *second*, optional floor (off by default — see MIN_COVERAGE_PCT). It
 * is reported on every point either way, so a reader can weigh a dip in the trend.
 */
export function extrapolateCapacity(
    ahCharged: number,
    socChange: number | null,
    coveragePct: number | null,
): number | null {
    if (socChange == null || socChange <= 0) return null;
    if (socChange < CAPACITY_SOC_THRESHOLD) return null;
    if (MIN_COVERAGE_PCT > 0 && (coveragePct == null || coveragePct < MIN_COVERAGE_PCT)) {
        return null;
    }
    return Math.round((ahCharged / (socChange / 100)) * 10) / 10;
}

/**
 * Is an estimate physically credible against the BMS nameplate?
 *
 * A pack cannot hold much more than it is rated for, and a pack at a third of
 * nameplate would be scrap rather than in service — so an estimate outside this
 * band means the *measurement* is broken, not the battery. This is the check that
 * would have caught the spreadsheet's 19.26 Ah against a 105 Ah nameplate.
 *
 * Returns true when there is no nameplate to check against: unknown is not a fault.
 */
export function capacityPlausible(
    estimateAh: number | null,
    ratedAh: number | null,
): boolean {
    if (estimateAh == null || ratedAh == null || ratedAh <= 0) return true;
    const ratio = estimateAh / ratedAh;
    return ratio >= 0.3 && ratio <= 1.5;
}
