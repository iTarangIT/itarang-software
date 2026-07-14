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
 * A gap longer than this ends the charging session. Sized to the real sample cadence
 * of telemetry_can, not to the device's nominal 30 s stream. An earlier value of
 * 1200 s split genuine sessions in half because it sat below the p90 gap between
 * stored samples.
 *
 * Declared after envNumber() rather than beside the other timing constants because it
 * is tuned against a cadence that keeps moving: the poller's spacing has drifted from
 * a p90 of ~2,010 s to ~3,720 s, which is *above* the old hardcoded 3,600 s — so the
 * gap rule alone was cutting real charges in two. Override with
 * TELEMETRY_SESSION_GAP_MAX_S and re-run scripts/diagnose-charging-cycles.ts, which
 * reports both the valid-cycle count and the interior-idle merges the value trades
 * against.
 *
 * 7200 is where the count stops being wrong. Measured against a limb scan of the raw
 * SOC series on the reference battery (62 real charges over 6 months):
 *
 *   gap    cycles counted   verdict
 *   3600      40            under-count by 22 (35% of real charges missed)
 *   5400      63            over-count by 1
 *   7200      62            exact match
 *   10800     62            exact match
 *
 * 7200 rather than 10800 because both land on the ground truth and the smaller value
 * has less room to stitch two charges together across an idle. It is not free: two of
 * the 62 runs merge a charge -> long flat idle -> charge into one. SOC alone cannot
 * separate those, and neither can the limb scan, so the count agrees with the yardstick
 * while both share that blind spot. See docs/intellicar-calculations.md §2.
 */
export const SESSION_GAP_MAX_S = envNumber("TELEMETRY_SESSION_GAP_MAX_S", 7200);

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
 * Minimum data coverage before a capacity is extrapolated. **On, at 15%.**
 *
 * This used to be off, on the finding that the SOC gate alone kept every estimate
 * plausible. That finding was an artefact of the old session rule: it cut charges at
 * every gap over an hour, so the fragments that survived were, by construction, the
 * densely-sampled ones. Widening SESSION_GAP_MAX_S to 7200 (see above) keeps whole
 * charges — including charges integrated across hours of interpolated current — and
 * the capacity estimates immediately spread out.
 *
 * Swept at the 20% SOC gate on the reference battery, after the session fix:
 *
 *   coverage   plotted   capacity range   sd
 *      0%        44       40-148 Ah      17.4     <- a 40 Ah reading on a 105 Ah pack
 *      5%        27       82-142 Ah      12.1
 *     10%        16       90-142 Ah      12.3
 *     15%        12       90-122 Ah       9.7     <- the knee
 *     20%         7       93-119 Ah       8.8
 *     40%         3       98-119 Ah       9.9
 *
 * 15 is the knee: it halves the scatter and removes the physically impossible
 * estimates while keeping a 12-point trend. 20 buys another 0.9 of standard deviation
 * for five of the twelve points, which is a bad trade on a chart that already cannot
 * resolve year-on-year degradation.
 *
 * Coverage is still reported on every point that clears the floor, and the UI still
 * marks anything under LOW_CONFIDENCE_COVERAGE as indicative. The floor only removes
 * the estimates that are not measurements at all.
 */
export const MIN_COVERAGE_PCT = envNumber("TELEMETRY_MIN_COVERAGE_PCT", 15);

/**
 * Fewest samples a cycle may have and still be coulomb-counted. Two samples describe
 * a single interval — one straight line through a whole charge — which is not an
 * integral, it is a guess with a slope.
 */
export const MIN_CYCLE_SAMPLES = envNumber("TELEMETRY_MIN_CYCLE_SAMPLES", 5);

/**
 * A charge must last at least this long to be a charge.
 *
 * This **replaces the old `SOC gain >= 5` rejection**, which threw away real top-ups solely
 * because they were small — and a small charge is still a charge. Duration is the honest test of
 * whether something physically happened: a 1% SOC tick over two minutes is quantisation noise or
 * a BMS re-estimate; a 3% gain over twenty minutes, carrying current the whole way, is a driver
 * topping up at a tea stall.
 *
 * Small cycles now survive detection and are graded by capacityConfidence() instead of being
 * silently deleted. See docs/intellicar-calculations.md §2.
 */
export const MIN_CYCLE_DURATION_S = envNumber("TELEMETRY_MIN_CYCLE_DURATION_S", 300);

/**
 * Retained for the *quality* assessment and for reporting only — **no longer a rejection gate.**
 *
 * A cycle below this is a top-up rather than a full charge, which is worth saying on the row. It
 * is not worth deleting the row over: capacity from a small swing is untrustworthy, not absent,
 * and withholding the number tells the reader less than the number plus its grade.
 */
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
 * **Computed for EVERY cycle whose SOC actually rose.** The only refusal is arithmetic:
 * a non-positive ΔSOC has nothing to extrapolate, and dividing by it would be a
 * divide-by-zero wearing a battery-health label.
 *
 * This used to refuse below CAPACITY_SOC_THRESHOLD and below MIN_COVERAGE_PCT, dropping the
 * cycle from the trend entirely. That is the wrong shape of answer: withholding a number tells
 * the reader nothing, while a number carrying its own confidence tells them everything they
 * need to weigh it. The amplification is real — the division multiplies the Ah total's error by
 * 100/ΔSOC, so a 1% swing amplifies it ×100 — but that is precisely what capacityConfidence()
 * exists to say.
 *
 * **Carry the grade wherever you carry the number.** A `low` estimate must never be plotted on a
 * degradation trend as though it were a `high` one.
 *
 * Coverage is deliberately NOT a parameter here. It decides how far to *trust* the answer, not
 * what the answer is — that is capacityConfidence()'s job, and taking it as an argument this
 * function then ignored would be a signature that lies about what it uses.
 */
export function extrapolateCapacity(
    ahCharged: number,
    socChange: number | null,
): number | null {
    if (socChange == null || socChange <= 0) return null;
    return Math.round((ahCharged / (socChange / 100)) * 10) / 10;
}

/** How far a capacity estimate can be trusted. Always travels with the estimate. */
export type Confidence = "high" | "medium" | "low";

/**
 * How far can this cycle's capacity be trusted?
 *
 * Three things independently wreck the extrapolation, and a cycle is only as good as its worst:
 *
 * - **SOC swing.** capacity = Ah ÷ (ΔSOC/100), so error is amplified ×(100/ΔSOC). At 20% that is
 *   ×5 and the estimates land in a credible band. At 5% it is ×20. At 1% it is ×100, and the
 *   answer is noise wearing a decimal point.
 * - **Coverage.** The share of the charge actually observed. Below the floor, the current between
 *   samples is interpolated, not measured — a straight line drawn through a curve nobody saw.
 * - **Sample count.** Two samples describe a single interval: one straight line through an entire
 *   charge. That is not an integral, it is a guess with a slope.
 *
 * Graded rather than gated. A cycle we rejected and a cycle we do not trust are different facts,
 * and the reader is owed the difference.
 */
export function capacityConfidence(
    socChange: number | null,
    coveragePct: number | null,
    nSamples: number,
): Confidence {
    if (socChange == null || socChange <= 0) return "low";

    const socStrong = socChange >= CAPACITY_SOC_THRESHOLD;
    const socUsable = socChange >= CAPACITY_SOC_THRESHOLD / 2;
    const covStrong = (coveragePct ?? 0) >= MIN_COVERAGE_PCT;
    const covUsable = (coveragePct ?? 0) >= MIN_COVERAGE_PCT / 2;
    const samplesStrong = nSamples >= MIN_CYCLE_SAMPLES;

    if (socStrong && covStrong && samplesStrong) return "high";
    if (socUsable && covUsable && nSamples >= 3) return "medium";
    return "low";
}

/**
 * Mean gap between stored samples inside the cycle, in seconds.
 *
 * n samples bound **n − 1** intervals, not n. Dividing the duration by the sample count
 * understates the spacing by a whole interval — on a 5-sample cycle that is a 25% error in the
 * very number a reader uses to judge how much to trust every other number.
 *
 * Reported, never a gate: it says how finely the charge was observed, which is exactly what is
 * needed to weigh the Ah integral behind it.
 */
export function avgSamplingIntervalS(
    durationS: number | null,
    nSamples: number,
): number | null {
    if (durationS == null || durationS <= 0 || nSamples < 2) return null;
    return Math.round((durationS / (nSamples - 1)) * 10) / 10;
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
