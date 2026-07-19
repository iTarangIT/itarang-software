/**
 * Pure load / overload arithmetic. No I/O, no imports from the DB layer — so the queries, the
 * charts and vitest can all share one definition.
 *
 * ## What "overload" means here, and why it is measurable when transients are not
 *
 * Overload is a *physical* load problem: the vehicle is carrying more mass than it should, so it
 * draws more charge for every kilometre it covers. That is a **sustained** condition lasting a
 * whole trip, and it is integrated over hours before we read it — which is exactly why it survives
 * this fleet's ~8.5-minute sampling when electrical transients do not. An over-current *spike*
 * lasts seconds and we catch roughly 1% of them (see fetchElectricalTrend); an overloaded rickshaw
 * is still overloaded eight minutes later.
 *
 * The measurement is Ah per km over a discharge cycle, where the Ah is SOC-derived (socDerivedAh)
 * rather than coulomb-counted. SOC is a state, not a rate, so it needs only the cycle's two
 * endpoints and does not degrade as the poller gets sparser. That robustness is what makes this
 * whole module possible.
 *
 * ## Why there is no "mileage vs current" here
 *
 * Because km/Ah = (v.dt)/(I.dt) = v/I identically, plotting mileage against current plots a
 * quantity against its own denominator — a hyperbola produced by division. Binning does not save
 * it: at our cadence the current that labels an interval is one instantaneous read of a value that
 * swung 0-50 A across the interval, so binning sorts intervals by their own error and manufactures
 * a ~9x collapse out of a vehicle whose mileage never changed. `load-math.test.ts` proves this
 * arithmetically and stands as the tripwire against rebuilding it.
 *
 * The honest question survives: *how much charge does this pack spend per kilometre, against the
 * best this same pack achieves?* That is the index below.
 *
 * ## No imports
 *
 * Nothing here reaches for the DB layer, so the charts can import it directly and vitest can cover
 * it without a connection string — the same rule thresholds-math.ts keeps. That is why MIN_TRIP_KM
 * is declared below rather than imported from cycle-distance.ts, which pulls in getIotSql: a
 * chart importing this module must not drag a Postgres client into the browser bundle.
 */

function envNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw == null || raw.trim() === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Fewest calibrated cycles before a baseline may be computed.
 *
 * The baseline is the pack's *best fifth*, so it needs enough cycles for a fifth to mean
 * something. Below this the "best" cycle is just the luckiest one, and an index built on it would
 * report overload on every normal trip.
 */
export const BASELINE_MIN_CYCLES = envNumber("TELEMETRY_LOAD_BASELINE_MIN_CYCLES", 8);

/**
 * Fewest kilometres, across those cycles, before a baseline may be computed.
 *
 * A cycle count alone is not enough: ten 2 km hops clear BASELINE_MIN_CYCLES while their best
 * fifth is a single 4 km trip whose GPS chord error dwarfs its signal.
 */
export const BASELINE_MIN_KM = envNumber("TELEMETRY_LOAD_BASELINE_MIN_KM", 50);

/**
 * The share of the window's kilometres that defines "this pack at its best".
 *
 * A fifth rather than a tenth: over a typical 2-3 month window a pack runs 20-40 usable cycles, so
 * 10% of the distance is one or two trips — back to a noise statistic. 20% is typically 4-8 cycles,
 * enough for the chord errors to start cancelling while still describing the light-load end.
 *
 * Not the minimum, ever. The single most efficient cycle is whichever one's GPS chord over-read
 * the most; it measures luck, not the vehicle.
 */
export const BASELINE_KM_FRACTION = envNumber("TELEMETRY_LOAD_BASELINE_KM_FRACTION", 0.2);

/**
 * Where an index stops being ordinary variation and is worth a look.
 *
 * **This number is invented**, exactly as the 70 A over-current default is, and it should be
 * replaced once someone weighs a loaded vehicle against its own telemetry. 1.25 says the pack spent
 * a quarter more charge per kilometre than it does at its own best — beyond what traffic and route
 * alone usually explain, but deliberately wide enough to stay quiet on a normal fleet.
 */
export const OVERLOAD_INDEX_WARN = envNumber("TELEMETRY_OVERLOAD_INDEX_WARN", 1.25);

/**
 * Below this, a cycle's "distance" is GPS jitter around a parked vehicle rather than a trip, and
 * its Ah/km is a division by noise.
 *
 * Mirrors MIN_CYCLE_KM in cycle-distance.ts, which is the source of truth — this module cannot
 * import it without pulling getIotSql into the client bundle (see the header). load-math.test.ts
 * asserts the two are equal, so they cannot drift apart silently.
 */
export const MIN_TRIP_KM = 1;

/** The active gates, so the UI can state what it filtered and why. */
export function loadGates() {
    return {
        baselineMinCycles: BASELINE_MIN_CYCLES,
        baselineMinKm: BASELINE_MIN_KM,
        baselineKmFraction: BASELINE_KM_FRACTION,
        overloadIndexWarn: OVERLOAD_INDEX_WARN,
        minTripKm: MIN_TRIP_KM,
    };
}

/** One discharge cycle, reduced to what a baseline needs. */
export interface BaselineInput {
    /** Calibrated distance covered inside the cycle window. */
    km: number;
    /** SOC-derived Ah drawn over the cycle — NOT the coulomb integral. */
    ah: number;
    /**
     * False when the cycle's km is a raw GPS chord (cycle-distance.ts returns `source: 'gps'`
     * when no day factor was computable). Such a cycle under-reads distance by ~27%, which is the
     * same size as a real overload — so it must never help define the baseline.
     */
    calibrated: boolean;
}

export interface Baseline {
    /** Ah per km across the best fifth, aggregated sum-first. */
    ahPerKm: number;
    /** How many cycles the fifth spanned — the reader's licence to believe it. */
    cycles: number;
    /** Kilometres those cycles covered. */
    km: number;
}

/**
 * The pack's own best-fifth Ah/km — the light-load reference every index is read against.
 *
 * Sum-first (total Ah over total km), never a mean of per-cycle ratios: a 2 km hop's ratio carries
 * enormous relative error, and averaging ratios lets it pull as hard as a 30 km run. This mirrors
 * `avgAhPerKm` in battery-queries.ts, which is the same rule for the same reason.
 *
 * Returns null rather than a weak answer when the floors are not met. A pack we cannot characterise
 * gets no baseline, no index and no reference line — the scatter still renders. That mirrors
 * capacityBands(), which gives a pack with no nameplate no bands rather than someone else's.
 *
 * **The index this feeds measures variation in load, not absolute load.** If the vehicle was loaded
 * on every trip in the window, the baseline is a loaded baseline and everything reads ~1.0. Saying
 * so on the card is not optional.
 */
export function baselineAhPerKm(cycles: readonly BaselineInput[]): Baseline | null {
    const usable = cycles.filter((c) => c.calibrated && c.km >= MIN_TRIP_KM && c.ah > 0);
    if (usable.length < BASELINE_MIN_CYCLES) return null;

    const totalKm = usable.reduce((a, c) => a + c.km, 0);
    if (totalKm < BASELINE_MIN_KM) return null;

    // Most efficient first — the light-load end of this pack's own range.
    const ranked = [...usable].sort((a, b) => a.ah / a.km - b.ah / b.km);

    const target = totalKm * BASELINE_KM_FRACTION;
    let km = 0;
    let ah = 0;
    let n = 0;
    for (const c of ranked) {
        km += c.km;
        ah += c.ah;
        n += 1;
        // The crossing cycle is included: one long efficient run can clear the fifth on its own,
        // and dropping it would leave the set empty and refuse a baseline the data supports.
        if (km >= target) break;
    }
    if (km <= 0) return null;

    return {
        ahPerKm: Math.round((ah / km) * 1000) / 1000,
        cycles: n,
        km: Math.round(km * 10) / 10,
    };
}

/**
 * How hard this cycle worked, against the pack's own best.
 *
 * A ratio of two like-measured quantities on the same pack in the same window, so the
 * *multiplicative* biases cancel to first order: nameplate error, the chord's undercount, slow
 * degradation. What does not cancel is traffic, gradient, tyre pressure and route — which is why
 * this is evidence, not a verdict.
 *
 * Null baseline yields null, never 1.0: "we could not characterise this pack" and "this pack is
 * perfectly normal" are different facts, and collapsing the first into the second is how a dead
 * signal ends up looking healthy.
 */
export function overloadIndex(
    cycleAhPerKm: number | null,
    baseline: number | null,
): number | null {
    if (cycleAhPerKm == null || baseline == null || baseline <= 0) return null;
    return Math.round((cycleAhPerKm / baseline) * 100) / 100;
}

/** Reported, not enforced — an unknown index is not a passing one. */
export function isOverloaded(index: number | null): boolean {
    return index != null && index >= OVERLOAD_INDEX_WARN;
}

/**
 * The Ah a cycle must have drawn to cover `km` at a given mileage — i.e. the iso-distance contour
 * on the Ah-vs-mileage chart.
 *
 * That chart plots Ah against km/Ah, so its two axes share a variable and lines of constant
 * distance are hyperbolae. Drawing them is what keeps a reader from mistaking the constraint for a
 * finding: a point's position along a contour is its efficiency, and which contour it sits on is
 * how far it went.
 */
export function isoDistanceAh(km: number, mileageKmPerAh: number): number | null {
    if (!(mileageKmPerAh > 0) || !(km > 0)) return null;
    return Math.round((km / mileageKmPerAh) * 100) / 100;
}
