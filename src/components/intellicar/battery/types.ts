/** Shapes returned by the /api/telemetry/analytics/* routes the Battery tab reads. */

/** How far a capacity estimate can be trusted. Always travels with the estimate. */
export type Confidence = 'high' | 'medium' | 'low';

export interface AhSession {
    /** 1-based, chronological — the "Charging Cycle Number". */
    cycle_no: number;
    start_time: string;
    end_time: string;
    duration_s: number;
    ah_charged: number;
    start_soc: number | null;
    end_soc: number | null;
    soc_difference: number | null;
    avg_charging_current: number | null;
    max_charging_current: number | null;
    coverage_pct: number | null;
    n_samples: number;
    n_current_samples: number;
    /** Mean seconds between stored samples — n−1 intervals, not n. */
    avg_sampling_interval_s: number | null;
    /** Widest silence inside the charge. */
    max_gap_s: number | null;
    rated_capacity_ah: number | null;
    /**
     * Estimated on EVERY cycle whose SOC rose — never withheld.
     *
     * Null only when the arithmetic is impossible (ΔSOC ≤ 0). Read it together with
     * `capacity_confidence`: a `low` grade is arithmetically valid and epistemically worthless,
     * and must never be plotted on a degradation trend as though it were a `high` one.
     */
    estimated_capacity_ah: number | null;
    capacity_confidence: Confidence;
    capacity_plausible: boolean;
    /** Gained less than the top-up threshold — a real charge, just a small one. */
    is_topup: boolean;
    enough_samples: boolean;
}

/** The three gates that can withhold a capacity, echoed back so the UI can explain itself. */
export interface CapacityGates {
    minSocDifference: number;
    minCoveragePct: number;
    minSamples: number;
}

export interface AhSummary {
    chargingCycles: number;
    totalAhCharged: number;
    avgAhPerSession: number;
    /** Averaged over HIGH-confidence estimates only. */
    avgCapacityAh: number | null;
    avgSessionDurationMin: number;
    avgSocGained: number;
    /** Mean seconds between stored samples, across every cycle. */
    avgSamplingIntervalS: number | null;
    /** How many cycles' capacity estimates can actually be trusted. */
    capacityConfidence: { high: number; medium: number; low: number };
    /** Real charges that gained less than the top-up threshold — counted, not discarded. */
    topUpCycles: number;
    ratedCapacityAh: number | null;
    implausibleCycles: number;
    gates: CapacityGates;
}

export interface AhAnalytics {
    vehicleno: string;
    months: number | null;
    month: string | null;
    sessions: AhSession[];
    summary: AhSummary;
}

export interface SocTimeline {
    points: Array<{ time: string; soc_pct: number | null; in_cycle: boolean }>;
}

/** One plotted point on the capacity trend, flattened for recharts. */
export interface CapacityPoint {
    t: string;
    capacity: number | null;
    cycleNo: number;
    startTime: string;
    endTime: string;
    durationS: number;
    startSoc: number | null;
    endSoc: number | null;
    socDiff: number | null;
    ahCharged: number;
    avgCurrent: number | null;
    coverage: number | null;
    samples: number;
    confidence: Confidence;
    /** Anything not `high`. Drawn hollow, and excluded from the trend LINE. */
    lowConfidence: boolean;
    /** Within 0.3×–1.5× of the nameplate. Implausible points must not scale the axis. */
    plausible: boolean;
}

/** Below this coverage a point is shown, but marked as indicative rather than solid. */
export const LOW_CONFIDENCE_COVERAGE = 40;

export const CAPACITY_COLOR = '#7c3aed';

export type Granularity = 'day' | 'week' | 'month';

// ─── Discharge ───────────────────────────────────────────────────────────────

export interface DischargeCycle {
    break_id: number;
    start_time: string;
    end_time: string;
    duration_s: number;
    start_soc: number | null;
    end_soc: number | null;
    min_soc: number | null;
    dod_pct: number | null;
    /** PRIMARY. From the SOC endpoints — survives sparse sampling. */
    ah_discharged_soc: number | null;
    /** SECONDARY. Coulomb-counted; null when too sparse to integrate. */
    ah_discharged_coulomb: number | null;
    divergence_pct: number | null;
    avg_discharge_current: number | null;
    max_discharge_current: number | null;
    n_samples: number;
    coulomb_trustworthy: boolean;
    rated_capacity_ah: number | null;
    /** Where the nameplate came from: the CAN payload, or the E-190 model-spec fallback. */
    rated_capacity_source?: 'can' | 'spec' | null;
    /** Distance covered inside the cycle window; null = no usable GPS. Route-enriched. */
    km?: number | null;
    /** 'gps' = uncalibrated chord — a lower bound, and the panel says so. */
    km_source?: 'calibrated' | 'gps' | null;
    km_per_ah?: number | null;
}

export interface DischargeAnalytics {
    cycles: DischargeCycle[];
    summary: {
        dischargeCycles: number;
        totalAhDischarged: number;
        avgDepthOfDischarge: number | null;
        avgAhPerCycle: number | null;
        medianDivergencePct: number | null;
        coulombTrustworthyCycles: number;
        ratedCapacityAh: number | null;
    };
}

export interface DeepDischargeEvent {
    event_id: number;
    start_time: string;
    end_time: string;
    duration_s: number;
    min_soc: number | null;
    n_samples: number;
    /** False → the low SOC is real but the span is not observed. */
    duration_confident: boolean;
}

export interface DeepDischargeData {
    events: DeepDischargeEvent[];
    byMonth: Array<{ month: string; count: number }>;
    gates: { minSocDrop: number; minSamples: number; deepEnterPct: number; deepExitPct: number };
}

// ─── Distance / energy ───────────────────────────────────────────────────────

export interface DistanceBucket {
    bucket: string;
    /** null = unknown. MUST render as a gap, never as a zero. */
    km: number | null;
    cum_km: number;
    has_telemetry: boolean;
}

export interface DistanceData {
    granularity: Granularity;
    buckets: DistanceBucket[];
    summary: {
        totalKm: number;
        activeBuckets: number;
        bucketsWithoutDistance: number;
        avgKmPerActiveBucket: number;
        /** Days with km > 0 — day-grained regardless of the chart's granularity. */
        activeDays: number;
        avgKmPerActiveDay: number;
    };
}

export interface EnergyBucket {
    bucket: string;
    ah_charged: number;
    ah_discharged: number;
    cum_charged: number;
    cum_discharged: number;
}

export interface EnergyData {
    granularity: Granularity;
    buckets: EnergyBucket[];
    summary: {
        totalCharged: number;
        totalDischarged: number;
        chargingCycles: number;
        dischargeCycles: number;
        netAh: number;
    };
}

export interface DischargeKmPoint {
    day: string;
    km: number;
    ah_discharged: number;
    ah_per_km: number | null;
    /** Mileage as a driver reads it: km per Ah. Feeds the mileage trend line. */
    km_per_ah: number | null;
    cycles: number;
}

/** One discharge cycle with the distance covered inside its own window. */
export interface DischargeKmCyclePoint {
    break_id: number;
    start_time: string;
    end_time: string;
    duration_s: number;
    dod_pct: number | null;
    km: number;
    /** 'gps' = uncalibrated chord, a lower bound — say so in the tooltip. */
    km_source: 'calibrated' | 'gps';
    ah_discharged: number;
    ah_per_km: number | null;
    km_per_ah: number | null;
    /** Ah/km against the pack's own best-fifth baseline. Null = no baseline, NOT "normal". */
    overload_index?: number | null;
}

/** Client mirror of `Baseline` (load-math.ts) — the pack's own light-load reference. */
export interface LoadBaseline {
    ahPerKm: number;
    cycles: number;
    km: number;
}

export interface DischargeKmData {
    points: DischargeKmPoint[];
    cycles: DischargeKmCyclePoint[];
    cycleSummary: {
        cycles: number;
        totalKm: number;
        totalAh: number;
        avgAhPerKm: number | null;
        cyclesWithoutDistance: number;
        /** % of plotted cycles whose km was calibrated against the daily rollup. */
        calibratedPct: number | null;
        /** Null when the window cannot support a baseline — see load-math.ts. */
        baseline: LoadBaseline | null;
        /** Cycles at or above the overload warn threshold. Null when there is no baseline. */
        overloadedCycles: number | null;
        gates: {
            baselineMinCycles: number;
            baselineMinKm: number;
            baselineKmFraction: number;
            overloadIndexWarn: number;
            minTripKm: number;
        };
    };
    summary: {
        days: number;
        totalKm: number;
        totalAh: number;
        avgAhPerKm: number | null;
        daysWithoutDischarge: number;
    };
}

// ─── Telemetry cadence ───────────────────────────────────────────────────────

/** Client mirror of `TelemetryCadence` (battery-queries.ts) — the real stored-sample cadence. */
export interface TelemetryCadence {
    medianIntervalS: number | null;
    p90IntervalS: number | null;
    samplesPerDay: number | null;
    lastSampleAt: string | null;
    duplicatePct: number | null;
}

// ─── Electrical ──────────────────────────────────────────────────────────────

export interface BatteryThresholds {
    underVoltageV: number;
    overVoltageV: number;
    overCurrentA: number;
    weakChargeCurrentA: number;
    overTemperatureC: number;
    capacityWarningFrac: number;
    capacityCriticalFrac: number;
    /**
     * E-201 — normal km-per-Ah efficiency band from the model spec, when the picked
     * vehicle maps to one. Spec-only and optional: null/absent means no band was recorded,
     * and the mileage charts draw no line rather than inventing a fleet number.
     */
    minMileageKmPerAh?: number | null;
    maxMileageKmPerAh?: number | null;
}

export interface ElectricalBucket {
    bucket: string;
    v_min: number | null;
    v_p05: number | null;
    v_med: number | null;
    v_p95: number | null;
    v_max: number | null;
    i_min: number | null;
    i_med: number | null;
    i_p95: number | null;
    i_max: number | null;
    t_med: number | null;
    t_max: number | null;
    n: number;
}

export interface ElectricalData {
    granularity: Granularity;
    buckets: ElectricalBucket[];
    thresholds: BatteryThresholds;
    breaches: {
        underVoltage: number;
        overVoltage: number;
        overCurrent: number;
        overTemperature: number;
        weakCharge: number;
    };
    summary: {
        nSamples: number;
        chargingCycles: number;
        /** Measured over this window for THIS battery. Null = too few samples to measure a gap. */
        medianSampleGapS: number | null;
    };
}

// ─── Location ────────────────────────────────────────────────────────────────

/** One cell of the kilometre heat map. `km` is the weight. */
export interface HeatCell {
    lat: number;
    lon: number;
    km: number;
}

/** A place the vehicle sits still. */
export interface DwellCluster {
    lat: number;
    lon: number;
    hours: number;
    /** Of those, the hours actually watched — the rest are inferred across telemetry gaps. */
    observedHours: number;
    visits: number;
    nightHours: number;
    nights: number;
    /** Most recent IST date it spent night hours here. */
    lastNight?: string | null;
}

/** The charging spot: a dwell cluster plus its charge-window evidence. */
export interface ChargingSpot extends DwellCluster {
    chargeHours: number;
    chargeSessions: number;
}

export interface BatteryGeoData {
    heat: HeatCell[];
    dwell: DwellCluster[];
    /** Where it spends most of its stationary time. */
    parking: DwellCluster | null;
    /** Where it sleeps — a behavioural inference, never an address. */
    home: DwellCluster | null;
    /** Where it charges — stationary time inside rising-SOC charge windows, ≥2 sessions. */
    charging: ChargingSpot | null;
    /** The runner-up overnight place, distinct from home. */
    overnightSecondary: DwellCluster | null;
    bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null;
    summary: {
        /** Straight-line hops between fixes — a LOWER BOUND. Never quote it as a distance. */
        gpsChordKm: number;
        fixes: number;
        movingHours: number;
        dwellHours: number;
        inferredDwellPct: number;
        days: number;
    };
    gates: {
        dwellRadiusM: number;
        moveMinM: number;
        dwellTrustGapS: number;
        nightStartHour: number;
        nightEndHour: number;
        gridDeg: number;
        chargingSpotMinSessions: number;
        secondaryOvernightMinNights: number;
    };
}
