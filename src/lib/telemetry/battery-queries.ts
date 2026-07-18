/**
 * Queries behind the Battery Analytics tab: discharge, deep discharge, distance, and the
 * cumulative energy view.
 *
 * Kept out of queries.ts, which is already 1,200 lines of fleet/device/alert reads. The
 * charge-side cycle queries stay there because the Excel export depends on them; everything
 * new lives here.
 *
 * Two of these — the energy trend and the discharge-vs-distance scatter — deliberately do
 * their joining in Node rather than in SQL. They combine the charge and discharge chains,
 * which would otherwise mean one query defining both CTE trees and re-deriving totals a
 * second time. The inputs are per-cycle rows (tens, not thousands), and reusing the
 * authoritative aggregates is what keeps every number on the page consistent with the
 * Charging Cycles card.
 */
import { getIotSql } from "@/lib/db/iot";
import {
    buildTimeWindow,
    sampleCTEs,
    type ChargingWindowOpts,
} from "@/lib/telemetry/charging-sql";
import { dischargeCTEs, deepDischargeCTEs } from "@/lib/telemetry/discharge-sql";
import {
    MIN_DISCHARGE_SAMPLES,
    ahPerKm,
    depthOfDischarge,
    dischargeDivergencePct,
    dischargeGates,
    kmPerAh,
    socDerivedAh,
} from "@/lib/telemetry/discharge-math";
import {
    MIN_CYCLE_KM,
    fetchCycleWindowKm,
    type CycleKmSource,
} from "@/lib/telemetry/cycle-distance";
import { SESSION_GAP_MAX_S } from "@/lib/telemetry/charging-math";
import {
    baselineAhPerKm,
    isOverloaded,
    loadGates,
    overloadIndex,
} from "@/lib/telemetry/load-math";
import { getBatteryThresholds } from "@/lib/telemetry/thresholds";
import { fetchChargingCycleAggregate } from "@/lib/telemetry/queries";

/** postgres.js returns numeric / EXTRACT columns as strings. Coerce every one of them. */
const num = (v: unknown): number | null =>
    v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null;

export type Granularity = "day" | "week" | "month";

/** Validated against a whitelist — it is interpolated into date_trunc(). */
export function parseGranularity(v: string | null | undefined): Granularity {
    return v === "week" || v === "month" ? v : "day";
}

// ─── Discharge cycles ────────────────────────────────────────────────────────

export interface DischargeCycle {
    break_id: number;
    start_time: Date;
    end_time: Date;
    duration_s: number;
    start_soc: number | null;
    end_soc: number | null;
    min_soc: number | null;
    /** Depth of discharge, in SOC points. */
    dod_pct: number | null;
    /** PRIMARY — from the SOC endpoints and the nameplate. Survives sparse sampling. */
    ah_discharged_soc: number | null;
    /** SECONDARY — coulomb-counted, accrued only where SOC fell. Believe it only when it agrees. */
    ah_discharged_coulomb: number | null;
    /** (coulomb − soc) / soc, as a percentage. The honest confidence signal. */
    divergence_pct: number | null;
    avg_discharge_current: number | null;
    max_discharge_current: number | null;
    n_samples: number;
    /** False → the coulomb figure is a straight line through a curve nobody saw. */
    coulomb_trustworthy: boolean;
    rated_capacity_ah: number | null;
    /** Where the nameplate came from: the CAN payload, or the E-190 model-spec fallback. */
    rated_capacity_source: "can" | "spec" | null;
}

export async function fetchDischargeAnalytics(
    vehicleno: string,
    opts: ChargingWindowOpts,
) {
    const iot = getIotSql();
    const { timePredicate, months, month, from, to } = buildTimeWindow(iot, opts);
    // E-190 fallback nameplate: some feeds (the post-AWS-migration poller among them) carry
    // no rated_capacity in the CAN payload, and without a nameplate every SOC-derived Ah —
    // the primary discharge series — is null. The model spec fills that hole per pack.
    const thresholdsPromise = getBatteryThresholds(vehicleno);

    const rows = (await iot`
        ${dischargeCTEs(iot, vehicleno, timePredicate)}
        SELECT break_id, start_time, end_time, duration_s,
               start_soc::float AS start_soc,
               end_soc::float   AS end_soc,
               min_soc::float   AS min_soc,
               round(ah_coulomb::numeric, 2)::float            AS ah_coulomb,
               round(avg_discharge_current::numeric, 1)::float AS avg_discharge_current,
               round(max_discharge_current::numeric, 1)::float AS max_discharge_current,
               n_samples,
               n_falling_samples,
               rated_capacity_ah
        FROM dis_valid
        WHERE is_valid
        ORDER BY start_time ASC
    `) as unknown as Array<Record<string, unknown>>;

    const specRatedAh = (await thresholdsPromise).ratedCapacityAh ?? null;

    const cycles: DischargeCycle[] = rows.map((r) => {
        const startSoc = num(r.start_soc);
        const endSoc = num(r.end_soc);
        const canRatedAh = num(r.rated_capacity_ah);
        const ratedAh = canRatedAh != null && canRatedAh > 0 ? canRatedAh : specRatedAh;
        const ratedSource: DischargeCycle["rated_capacity_source"] =
            canRatedAh != null && canRatedAh > 0 ? "can" : ratedAh != null ? "spec" : null;
        const nSamples = Number(r.n_samples) || 0;

        const socAh = socDerivedAh(startSoc, endSoc, ratedAh);
        const coulombRaw = num(r.ah_coulomb);
        // A coulomb integral over 2-3 points is a slope, not an integral. Report it as
        // absent rather than as a number, exactly as the charge side declines a capacity.
        const trustworthy = nSamples >= MIN_DISCHARGE_SAMPLES && coulombRaw != null && coulombRaw > 0;
        const coulombAh = trustworthy ? coulombRaw : null;

        return {
            break_id: Number(r.break_id),
            start_time: r.start_time as Date,
            end_time: r.end_time as Date,
            duration_s: Number(r.duration_s) || 0,
            start_soc: startSoc,
            end_soc: endSoc,
            min_soc: num(r.min_soc),
            dod_pct: depthOfDischarge(startSoc, endSoc),
            ah_discharged_soc: socAh,
            ah_discharged_coulomb: coulombAh,
            divergence_pct: dischargeDivergencePct(socAh, coulombAh),
            avg_discharge_current: num(r.avg_discharge_current),
            max_discharge_current: num(r.max_discharge_current),
            n_samples: nSamples,
            coulomb_trustworthy: trustworthy,
            rated_capacity_ah: ratedAh,
            rated_capacity_source: ratedSource,
        };
    });

    const socAhs = cycles.map((c) => c.ah_discharged_soc).filter((v): v is number => v != null);
    const dods = cycles.map((c) => c.dod_pct).filter((v): v is number => v != null);
    const divs = cycles.map((c) => c.divergence_pct).filter((v): v is number => v != null);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const round1 = (v: number | null) => (v != null ? Math.round(v * 10) / 10 : null);

    return {
        vehicleno,
        months,
        month,
        from,
        to,
        cycles,
        summary: {
            dischargeCycles: cycles.length,
            totalAhDischarged: round1(socAhs.reduce((a, b) => a + b, 0)) ?? 0,
            avgDepthOfDischarge: round1(mean(dods)),
            avgAhPerCycle: round1(mean(socAhs)),
            /** Median |divergence| between the two methods — how much the coulomb series can be trusted. */
            medianDivergencePct: divs.length
                ? round1([...divs.map(Math.abs)].sort((a, b) => a - b)[Math.floor(divs.length / 2)])
                : null,
            coulombTrustworthyCycles: cycles.filter((c) => c.coulomb_trustworthy).length,
            ratedCapacityAh: cycles[0]?.rated_capacity_ah ?? null,
        },
        gates: dischargeGates(),
    };
}

// ─── Deep discharge (<20% SOC) ───────────────────────────────────────────────

export interface DeepDischargeEvent {
    event_id: number;
    start_time: Date;
    end_time: Date;
    duration_s: number;
    min_soc: number | null;
    n_samples: number;
    /**
     * False when the widest telemetry gap inside the event exceeds a session gap: the low
     * SOC is a fact regardless, but the *duration* would be an assumption.
     */
    duration_confident: boolean;
}

export async function fetchDeepDischarge(vehicleno: string, opts: ChargingWindowOpts) {
    const iot = getIotSql();
    const { timePredicate, months, month, from, to } = buildTimeWindow(iot, opts);

    const rows = (await iot`
        ${deepDischargeCTEs(iot, vehicleno, timePredicate)}
        SELECT event_id, start_time, end_time, duration_s,
               min_soc::float AS min_soc, n_samples, max_gap_s
        FROM dd_events
        ORDER BY start_time ASC
    `) as unknown as Array<Record<string, unknown>>;

    const events: DeepDischargeEvent[] = rows.map((r) => ({
        event_id: Number(r.event_id),
        start_time: r.start_time as Date,
        end_time: r.end_time as Date,
        duration_s: Number(r.duration_s) || 0,
        min_soc: num(r.min_soc),
        n_samples: Number(r.n_samples) || 0,
        duration_confident: (num(r.max_gap_s) ?? 0) <= SESSION_GAP_MAX_S,
    }));

    // Monthly counts. Built from the events themselves rather than a second GROUP BY query,
    // so the table and the bars can never disagree about how many events there were.
    const byMonthMap = new Map<string, number>();
    for (const e of events) {
        const key = new Date(e.start_time).toISOString().slice(0, 7); // YYYY-MM
        byMonthMap.set(key, (byMonthMap.get(key) ?? 0) + 1);
    }
    const byMonth = [...byMonthMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([month_, count]) => ({ month: month_, count }));

    return {
        vehicleno,
        months,
        month,
        from,
        to,
        events,
        byMonth,
        gates: dischargeGates(),
    };
}

// ─── Distance ────────────────────────────────────────────────────────────────

export interface DistanceBucket {
    bucket: string;
    /**
     * Kilometres driven, or **null when we do not know**.
     *
     * Load-bearing, and the single easiest thing to get wrong here. `distance_rollup` is
     * produced by an aggregator outside this repo, and its sibling table
     * (`daily_distance_per_vehicle`) was never populated at all — so the absence of a row is
     * NOT evidence the vehicle stood still. Coalescing a missing row to 0 asserts "parked"
     * on a day we simply have no distance for, and a cumulative line that flattens for a
     * fortnight then reads as "this driver stopped working" when it means "the aggregator
     * stopped writing".
     *
     * null MUST render as a gap in the line, never as a zero.
     */
    km: number | null;
    /** Running total over the buckets we actually know. A lower bound whenever km is null. */
    cum_km: number;
    /**
     * Whether the *battery* (telemetry_can) reported in this bucket.
     *
     * Informational, and deliberately NOT what decides a gap: distance comes from a different
     * feed, and on this fleet the GPS/distance rollup predates the CAN feed by a fortnight —
     * so there are buckets with real kilometres and no battery telemetry at all. Using this
     * to blank the distance line would hide 150 km of genuine travel.
     */
    has_telemetry: boolean;
}

export async function fetchDistanceTrend(
    vehicleno: string,
    opts: ChargingWindowOpts,
    granularity: Granularity = "day",
) {
    const iot = getIotSql();
    const { timePredicate, months, month, from, to } = buildTimeWindow(iot, opts);

    // `raw` (from sampleCTEs) is the deduped telemetry_can series — the evidence that the
    // device was alive. distance_rollup is the only populated distance source: the per-trip
    // `trips` table is empty fleet-wide, and daily_distance_per_vehicle was never populated.
    const [rows, dayAggRows] = await Promise.all([
        iot`
            ${sampleCTEs(iot, vehicleno, timePredicate)},
            -- Bucket in UTC explicitly (AT TIME ZONE 'UTC' both ways) so these keys always match
            -- the Node-side bucketKey() (UTC) that the energy trend uses — the two are FULL-OUTER
            -- joined by month on the monthly chart. Without this, a future IoT session TZ other
            -- than UTC would silently shift distance months and mis-join. Safe no-op while UTC.
            tel AS (
                SELECT date_trunc(${granularity}, time AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
                       count(*)::int AS n
                FROM raw
                GROUP BY 1
            ),
            dist AS (
                SELECT date_trunc(${granularity}, time AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
                       sum(distance_km)::float AS km
                FROM distance_rollup
                WHERE vehicleno = ${vehicleno}
                  AND bucket_size = 'day'
                  ${timePredicate}
                GROUP BY 1
            )
            -- No COALESCE on km. A missing distance row is unknown, not zero.
            SELECT COALESCE(t.bucket, d.bucket)   AS bucket,
                   d.km::float                    AS km,
                   (t.bucket IS NOT NULL)         AS has_telemetry
            FROM tel t
            FULL OUTER JOIN dist d USING (bucket)
            ORDER BY 1 ASC
        ` as unknown as Promise<Array<Record<string, unknown>>>,
        // "Active Days" stays in DAYS whatever the chart's granularity — a week bucket with
        // one working day must not read as one active week. At day grain the buckets already
        // carry it, so the extra aggregate only runs when the grains differ.
        granularity === "day"
            ? Promise.resolve(null)
            : (iot`
                SELECT count(*) FILTER (WHERE km > 0)::int AS active_days
                FROM (
                    SELECT sum(distance_km) AS km
                    FROM distance_rollup
                    WHERE vehicleno = ${vehicleno}
                      AND bucket_size = 'day'
                      ${timePredicate}
                    GROUP BY date_trunc('day', time)
                ) d
            ` as unknown as Promise<Array<Record<string, unknown>>>),
    ]);

    let cum = 0;
    const buckets: DistanceBucket[] = rows.map((r) => {
        const raw = num(r.km);
        const km = raw != null ? Math.round(raw * 10) / 10 : null;
        if (km != null) cum = Math.round((cum + km) * 10) / 10;
        return {
            bucket: new Date(r.bucket as string).toISOString(),
            km,
            cum_km: cum,
            has_telemetry: r.has_telemetry === true,
        };
    });

    const known = buckets.filter((b) => b.km != null) as Array<DistanceBucket & { km: number }>;
    const totalKm = Math.round(known.reduce((a, b) => a + b.km, 0) * 10) / 10;
    const active = known.filter((b) => b.km > 0).length;
    const unknown = buckets.length - known.length;
    const activeDays = dayAggRows ? Number(dayAggRows[0]?.active_days) || 0 : active;

    return {
        vehicleno,
        months,
        month,
        from,
        to,
        granularity,
        buckets,
        summary: {
            totalKm,
            activeBuckets: active,
            /**
             * Buckets the battery reported in but that carry no distance row. Their distance
             * is unknown, so totalKm is a LOWER BOUND whenever this is non-zero — say so on
             * the chart rather than letting a flat cumulative line imply a stationary vehicle.
             */
            bucketsWithoutDistance: unknown,
            avgKmPerActiveBucket: active ? Math.round((totalKm / active) * 10) / 10 : 0,
            /** Days with a distance row and km > 0 — day-grained regardless of granularity. */
            activeDays,
            avgKmPerActiveDay: activeDays
                ? Math.round((totalKm / activeDays) * 10) / 10
                : 0,
        },
    };
}

// ─── Telemetry cadence (how often the poller actually stores a sample) ────────

/**
 * What the STORED telemetry cadence really is for a battery — the honest counter to the
 * "reads every 30 s" expectation. The device streams ~30 s, but the AWS poller subsamples to
 * ~100 rows/day (~8.5 min median between distinct timestamps) and re-inserts duplicates. This
 * surfaces that reality on the dashboard so nobody mistakes the gaps for 30 s.
 *
 * Same DISTINCT-ON + percentile pattern the diagnostic (§1) uses, so the number the UI shows is
 * the number the analysis runs on.
 */
export interface TelemetryCadence {
    /** Median seconds between distinct stored samples. */
    medianIntervalS: number | null;
    /** 90th-percentile gap — the fat tail the median hides. */
    p90IntervalS: number | null;
    /** Distinct samples per day over the window. */
    samplesPerDay: number | null;
    /** Newest stored sample (ISO), for a "last seen" readout. */
    lastSampleAt: string | null;
    /** Share of rows that merely repeat an existing timestamp (poller re-insert). */
    duplicatePct: number | null;
}

export async function fetchTelemetryCadence(
    vehicleno: string,
    opts: ChargingWindowOpts,
): Promise<TelemetryCadence> {
    const iot = getIotSql();
    const { timePredicate } = buildTimeWindow(iot, opts);

    const [row] = (await iot`
        WITH d AS (
            SELECT DISTINCT ON (time) time
            FROM telemetry_can
            WHERE vehicleno = ${vehicleno}
              AND payload->'soc'->>'value' IS NOT NULL
              ${timePredicate}
            ORDER BY time
        ),
        cnt AS (
            SELECT count(*)::int AS raw_rows
            FROM telemetry_can
            WHERE vehicleno = ${vehicleno}
              AND payload->'soc'->>'value' IS NOT NULL
              ${timePredicate}
        ),
        g AS (
            SELECT EXTRACT(EPOCH FROM (time - LAG(time) OVER (ORDER BY time))) AS gap FROM d
        )
        SELECT (SELECT raw_rows FROM cnt)                                  AS raw_rows,
               (SELECT count(*)::int FROM d)                              AS distinct_rows,
               (SELECT max(time) FROM d)                                  AS last_sample,
               (SELECT EXTRACT(EPOCH FROM (max(time) - min(time))) FROM d) AS span_s,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)           AS p50,
               percentile_cont(0.9) WITHIN GROUP (ORDER BY gap)           AS p90
        FROM g WHERE gap IS NOT NULL
    `) as unknown as Array<Record<string, unknown>>;

    const rawRows = Number(row?.raw_rows) || 0;
    const distinctRows = Number(row?.distinct_rows) || 0;
    const spanS = num(row?.span_s);
    const days = spanS != null && spanS > 0 ? spanS / 86400 : null;

    return {
        medianIntervalS: num(row?.p50),
        p90IntervalS: num(row?.p90),
        samplesPerDay:
            days != null && days > 0 ? Math.round((distinctRows / days) * 10) / 10 : null,
        lastSampleAt: row?.last_sample
            ? new Date(row.last_sample as string).toISOString()
            : null,
        duplicatePct:
            rawRows > 0 ? Math.round((1 - distinctRows / rawRows) * 1000) / 10 : null,
    };
}

// ─── Cumulative energy (charge + discharge together) ─────────────────────────

export interface EnergyBucket {
    bucket: string;
    ah_charged: number;
    ah_discharged: number;
    cum_charged: number;
    cum_discharged: number;
}

function bucketKey(d: Date, g: Granularity): string {
    const t = new Date(d);
    t.setUTCHours(0, 0, 0, 0);
    if (g === "month") t.setUTCDate(1);
    if (g === "week") {
        // ISO-ish: snap back to Monday.
        const dow = (t.getUTCDay() + 6) % 7;
        t.setUTCDate(t.getUTCDate() - dow);
    }
    return t.toISOString();
}

/**
 * Ah in and Ah out over time, and their running totals.
 *
 * Reuses fetchChargingCycleAggregate rather than re-deriving charge totals: that function is
 * the authoritative source for every charge number on this dashboard, and a second
 * derivation would be a second thing to keep in step with the Charging Cycles card.
 *
 * Discharge uses the SOC-derived figure (socDerivedAh), NOT the coulomb integral — see
 * discharge-math.ts for why the two are not interchangeable.
 */
export async function fetchEnergyTrend(
    vehicleno: string,
    opts: ChargingWindowOpts,
    granularity: Granularity = "day",
) {
    const [charge, discharge] = await Promise.all([
        fetchChargingCycleAggregate(vehicleno, opts),
        fetchDischargeAnalytics(vehicleno, opts),
    ]);

    const map = new Map<string, { ah_charged: number; ah_discharged: number }>();
    const at = (k: string) => {
        let v = map.get(k);
        if (!v) map.set(k, (v = { ah_charged: 0, ah_discharged: 0 }));
        return v;
    };

    for (const c of charge.cycles) {
        at(bucketKey(new Date(c.start_time), granularity)).ah_charged += c.ah_charged ?? 0;
    }
    for (const d of discharge.cycles) {
        at(bucketKey(new Date(d.start_time), granularity)).ah_discharged += d.ah_discharged_soc ?? 0;
    }

    let cumC = 0;
    let cumD = 0;
    const buckets: EnergyBucket[] = [...map.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([bucket, v]) => {
            const ahC = Math.round(v.ah_charged * 10) / 10;
            const ahD = Math.round(v.ah_discharged * 10) / 10;
            cumC = Math.round((cumC + ahC) * 10) / 10;
            cumD = Math.round((cumD + ahD) * 10) / 10;
            return { bucket, ah_charged: ahC, ah_discharged: ahD, cum_charged: cumC, cum_discharged: cumD };
        });

    return {
        vehicleno,
        granularity,
        buckets,
        summary: {
            totalCharged: cumC,
            totalDischarged: cumD,
            chargingCycles: charge.cycles.length,
            dischargeCycles: discharge.cycles.length,
            /**
             * Ah out minus Ah in. Over a long window on a battery that starts and ends at a
             * similar SOC these should roughly match; a large persistent imbalance means one
             * of the two measurements is wrong, not that the pack is creating charge.
             */
            netAh: Math.round((cumC - cumD) * 10) / 10,
        },
    };
}

// ─── Electrical: voltage / current / temperature ─────────────────────────────

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

export interface Breaches {
    underVoltage: number;
    overVoltage: number;
    overCurrent: number;
    overTemperature: number;
    /** Charging cycles whose average current was below the weak-charge threshold. */
    weakCharge: number;
}

/**
 * Voltage, current and temperature as **bucketed statistics**, never a raw per-sample line.
 *
 * Pack voltage and current move on a ~1-second timescale. We sample every ~8.5 minutes
 * (p90: 33 min). Plotting 36,000 raw points draws a solid noise band that carries no
 * information and invites a reader to "see" spikes that are aliasing artefacts. A per-bucket
 * min/median/max envelope says exactly what we know and no more.
 *
 * ## The breach counts are LOWER BOUNDS, not counts
 *
 * A real over-voltage transient lasts seconds. At a ~510 s median sampling interval the
 * probability of catching a 5-second spike is about 1%. **We will miss roughly 99% of
 * transient electrical events.** "0 over-voltage events" means *we did not see one*, not
 * *there was not one*, and the UI must say so on the card face.
 *
 * The honest fix is upstream: the BMS sees every frame, so the poller should emit an `alerts`
 * row on a breach. Inferring transients in the CRM from 1% of the data cannot be made correct
 * by any amount of query work.
 *
 * Temperature is the exception, and the only red flag here that fully works: thermal mass
 * moves on a *minutes* timescale, so an over-temperature event is genuinely observable at
 * this cadence.
 */
export async function fetchElectricalTrend(
    vehicleno: string,
    opts: ChargingWindowOpts,
    granularity: Granularity = "day",
) {
    const iot = getIotSql();
    const { timePredicate, months, month, from, to } = buildTimeWindow(iot, opts);
    // E-190: fields defined by this vehicle's battery_spec_models row override the
    // fleet-wide settings, so the bands and breach counts judge the pack by its model.
    const t = await getBatteryThresholds(vehicleno);

    // One pass over the deduped series produces both the envelope and the breach counts, so
    // the numbers on the cards and the shape of the chart can never come from different rows.
    const [rows, breachRow] = await Promise.all([
        iot`
            ${sampleCTEs(iot, vehicleno, timePredicate)},
            temp AS (
                SELECT DISTINCT ON (time)
                    time,
                    (payload->'battery_temp'->>'value')::float AS pack_temp_c
                FROM telemetry_can
                WHERE vehicleno = ${vehicleno}
                  AND payload->'battery_temp'->>'value' IS NOT NULL
                  ${timePredicate}
                ORDER BY time
            )
            SELECT
                date_trunc(${granularity}, s.time)                                        AS bucket,
                round(min(s.pack_voltage)::numeric, 1)::float                             AS v_min,
                round(percentile_cont(0.05) WITHIN GROUP (ORDER BY s.pack_voltage)::numeric, 1)::float AS v_p05,
                round(percentile_cont(0.50) WITHIN GROUP (ORDER BY s.pack_voltage)::numeric, 1)::float AS v_med,
                round(percentile_cont(0.95) WITHIN GROUP (ORDER BY s.pack_voltage)::numeric, 1)::float AS v_p95,
                round(max(s.pack_voltage)::numeric, 1)::float                             AS v_max,
                round(min(s.pack_current)::numeric, 1)::float                             AS i_min,
                round(percentile_cont(0.50) WITHIN GROUP (ORDER BY s.pack_current)::numeric, 1)::float AS i_med,
                round(percentile_cont(0.95) WITHIN GROUP (ORDER BY s.pack_current)::numeric, 1)::float AS i_p95,
                round(max(s.pack_current)::numeric, 1)::float                             AS i_max,
                round(percentile_cont(0.50) WITHIN GROUP (ORDER BY tp.pack_temp_c)::numeric, 1)::float AS t_med,
                round(max(tp.pack_temp_c)::numeric, 1)::float                             AS t_max,
                count(*)::int                                                             AS n
            FROM stepped s
            LEFT JOIN temp tp USING (time)
            GROUP BY 1
            ORDER BY 1 ASC
        `,
        iot`
            ${sampleCTEs(iot, vehicleno, timePredicate)},
            temp AS (
                SELECT DISTINCT ON (time)
                    time,
                    (payload->'battery_temp'->>'value')::float AS pack_temp_c
                FROM telemetry_can
                WHERE vehicleno = ${vehicleno}
                  AND payload->'battery_temp'->>'value' IS NOT NULL
                  ${timePredicate}
                ORDER BY time
            )
            SELECT
                count(*) FILTER (WHERE s.pack_voltage IS NOT NULL AND s.pack_voltage < ${t.underVoltageV})::int AS under_voltage,
                count(*) FILTER (WHERE s.pack_voltage > ${t.overVoltageV})::int                                 AS over_voltage,
                count(*) FILTER (WHERE ABS(s.pack_current) > ${t.overCurrentA})::int                            AS over_current,
                count(*) FILTER (WHERE tp.pack_temp_c > ${t.overTemperatureC})::int                             AS over_temperature,
                count(*)::int                                                                                   AS n_samples
            FROM stepped s
            LEFT JOIN temp tp USING (time)
        `,
    ]);

    const buckets: ElectricalBucket[] = (rows as unknown as Array<Record<string, unknown>>).map(
        (r) => ({
            bucket: new Date(r.bucket as string).toISOString(),
            v_min: num(r.v_min),
            v_p05: num(r.v_p05),
            v_med: num(r.v_med),
            v_p95: num(r.v_p95),
            v_max: num(r.v_max),
            i_min: num(r.i_min),
            i_med: num(r.i_med),
            i_p95: num(r.i_p95),
            i_max: num(r.i_max),
            t_med: num(r.t_med),
            t_max: num(r.t_max),
            n: Number(r.n) || 0,
        }),
    );

    const b = (breachRow as unknown as Array<Record<string, unknown>>)[0] ?? {};

    // Weak charge is the one "under current" reading worth having, and it is only meaningful
    // INSIDE a charging cycle — a naive threshold on instantaneous current fires on every
    // parked vehicle. Reuses the authoritative charge aggregate rather than a second query.
    //
    // The cadence is fetched alongside it because the breach cards quote it as the reason their
    // counts are a floor. It has to be THIS battery's measured cadence over THIS window: the
    // poller's spacing differs per vehicle and drifts over time, so a constant would be a stale
    // number wearing a measurement's clothes.
    const [charge, cadence] = await Promise.all([
        fetchChargingCycleAggregate(vehicleno, opts),
        fetchTelemetryCadence(vehicleno, opts),
    ]);
    const weakCharge = charge.cycles.filter(
        (c) => c.avg_charging_current != null && c.avg_charging_current < t.weakChargeCurrentA,
    ).length;

    const nSamples = Number(b.n_samples) || 0;

    return {
        vehicleno,
        months,
        month,
        from,
        to,
        granularity,
        buckets,
        thresholds: t,
        breaches: {
            underVoltage: Number(b.under_voltage) || 0,
            overVoltage: Number(b.over_voltage) || 0,
            overCurrent: Number(b.over_current) || 0,
            overTemperature: Number(b.over_temperature) || 0,
            weakCharge,
        } satisfies Breaches,
        summary: {
            nSamples,
            chargingCycles: charge.cycles.length,
            /**
             * The median gap between stored samples over this window, in seconds — measured, not
             * assumed. Rendered on the breach cards so the reader can see for themselves why a
             * count of transients is a floor: a spike shorter than this interval is invisible.
             *
             * Was hardcoded to 510, the fleet-wide p50 read off one review in July 2026. That is a
             * real measurement of a *different* thing: cadence varies per battery and the poller's
             * spacing has drifted (p90 ~2,010 s -> ~3,720 s; see charging-math.ts). Quoting a fixed
             * number on a card that says "this battery is sampled about every N minutes" made a
             * constant look like an observation. Null when the window holds too few samples to
             * measure a gap — the card must say so rather than fall back to a number.
             */
            medianSampleGapS: cadence.medianIntervalS,
        },
    };
}

// ─── Discharge vs distance (daily) ───────────────────────────────────────────

export interface DischargeKmPoint {
    day: string;
    km: number;
    ah_discharged: number;
    /** Ah drawn per kilometre — the efficiency number this chart exists to expose. */
    ah_per_km: number | null;
    /** The same ratio as a driver reads it: km per Ah. Feeds the mileage trend. */
    km_per_ah: number | null;
    cycles: number;
}

/** One discharge cycle with the distance it covered — one scatter point. */
export interface DischargeKmCyclePoint {
    break_id: number;
    start_time: Date;
    end_time: Date;
    duration_s: number;
    dod_pct: number | null;
    /** Calibrated GPS distance over the cycle window (cycle-distance.ts). */
    km: number;
    /** 'gps' = uncalibrated chord, a lower bound — the tooltip must say so. */
    km_source: CycleKmSource;
    /** SOC-derived Ah out (the primary series — see discharge-math.ts). */
    ah_discharged: number;
    ah_per_km: number | null;
    km_per_ah: number | null;
    /**
     * This cycle's Ah/km against the pack's own best-fifth baseline. >1 means it spent more charge
     * per kilometre than this same pack does at its lightest. Null when no baseline was computable
     * — which is NOT the same as 1.0.
     */
    overload_index?: number | null;
}

/**
 * Ah discharged against kilometres driven, **per day**.
 *
 * Per day, not per cycle, and that is a data constraint rather than a design choice.
 * Distance exists only as a daily rollup (`distance_rollup`, bucket_size='day'); the
 * per-trip `trips` table is empty across the whole fleet. Splitting a day's kilometres
 * between the several discharge cycles inside that day would be an invention, so the day is
 * the finest unit this can honestly be computed at.
 *
 * The slope of the resulting scatter is the pack's Ah/km, and a battery drifting upward on
 * it is doing more work for the same distance.
 */
export async function fetchDischargeVsKm(vehicleno: string, opts: ChargingWindowOpts) {
    const [discharge, distance] = await Promise.all([
        fetchDischargeAnalytics(vehicleno, opts),
        fetchDistanceTrend(vehicleno, opts, "day"),
    ]);

    const byDay = new Map<string, { ah: number; cycles: number }>();
    for (const c of discharge.cycles) {
        const key = bucketKey(new Date(c.start_time), "day");
        const v = byDay.get(key) ?? { ah: 0, cycles: 0 };
        v.ah += c.ah_discharged_soc ?? 0;
        v.cycles += 1;
        byDay.set(key, v);
    }

    // Only days that have BOTH a discharge and a distance reading can carry a ratio. A day
    // with distance but no detected discharge is not a zero — it is a day the SOC series was
    // too coarse to resolve — so it is left out rather than dragged onto the axis at 0.
    const points: DischargeKmPoint[] = [];
    for (const b of distance.buckets) {
        const d = byDay.get(b.bucket);
        if (!d || b.km == null || b.km <= 0) continue;
        const ah = Math.round(d.ah * 10) / 10;
        points.push({
            day: b.bucket,
            km: b.km,
            ah_discharged: ah,
            ah_per_km: ahPerKm(ah, b.km),
            km_per_ah: kmPerAh(b.km, ah),
            cycles: d.cycles,
        });
    }

    const totalKm = Math.round(points.reduce((a, b) => a + b.km, 0) * 10) / 10;
    const totalAh = Math.round(points.reduce((a, b) => a + b.ah_discharged, 0) * 10) / 10;

    // ── Per-cycle scatter points ──────────────────────────────────────────────
    // One point per discharge cycle, with the distance covered inside that cycle's own
    // window (GPS chord calibrated against the daily rollup — cycle-distance.ts). Cycles
    // with no usable Ah or under MIN_CYCLE_KM of movement are parked SOC-drains, not
    // trips; they are counted rather than plotted at the axis.
    const kmByCycle = await fetchCycleWindowKm(
        vehicleno,
        opts,
        discharge.cycles.map((c) => ({
            id: c.break_id,
            start: new Date(c.start_time),
            end: new Date(c.end_time),
        })),
    );
    const cyclePoints: DischargeKmCyclePoint[] = [];
    let cyclesWithoutDistance = 0;
    for (const c of discharge.cycles) {
        const ah = c.ah_discharged_soc;
        const dist = kmByCycle.get(c.break_id);
        if (ah == null || ah <= 0 || dist == null || dist.km < MIN_CYCLE_KM) {
            cyclesWithoutDistance += 1;
            continue;
        }
        cyclePoints.push({
            break_id: c.break_id,
            start_time: c.start_time,
            end_time: c.end_time,
            duration_s: c.duration_s,
            dod_pct: c.dod_pct,
            km: dist.km,
            km_source: dist.source,
            ah_discharged: ah,
            ah_per_km: ahPerKm(ah, dist.km),
            km_per_ah: kmPerAh(dist.km, ah),
        });
    }
    const cycleKmTotal = Math.round(cyclePoints.reduce((a, c) => a + c.km, 0) * 10) / 10;
    const cycleAhTotal =
        Math.round(cyclePoints.reduce((a, c) => a + c.ah_discharged, 0) * 10) / 10;

    // The pack's own light-load reference, and each cycle's index against it. Computed here rather
    // than in the chart so the number the card quotes and the number the scatter plots come from
    // one place — the same reason the Ah totals above are not re-summed client-side.
    const baseline = baselineAhPerKm(
        cyclePoints.map((c) => ({
            km: c.km,
            ah: c.ah_discharged,
            calibrated: c.km_source === "calibrated",
        })),
    );
    for (const c of cyclePoints) {
        c.overload_index = overloadIndex(c.ah_per_km, baseline?.ahPerKm ?? null);
    }

    return {
        vehicleno,
        points,
        cycles: cyclePoints,
        cycleSummary: {
            cycles: cyclePoints.length,
            totalKm: cycleKmTotal,
            totalAh: cycleAhTotal,
            /**
             * The best fifth of this pack's own kilometres — null when the window cannot support
             * one. Null means "not characterised", never "normal": see load-math.ts.
             */
            baseline,
            /** Cycles at or above OVERLOAD_INDEX_WARN. Null when there is no baseline to judge against. */
            overloadedCycles: baseline
                ? cyclePoints.filter((c) => isOverloaded(c.overload_index ?? null)).length
                : null,
            gates: loadGates(),
            /** Aggregate ratio, not mean-of-ratios — same reasoning as the daily summary. */
            avgAhPerKm:
                cycleKmTotal > 0
                    ? Math.round((cycleAhTotal / cycleKmTotal) * 1000) / 1000
                    : null,
            /** Valid cycles with no plottable distance — parked drains or GPS-silent windows. */
            cyclesWithoutDistance,
            calibratedPct: cyclePoints.length
                ? Math.round(
                      (cyclePoints.filter((c) => c.km_source === "calibrated").length /
                          cyclePoints.length) *
                          100,
                  )
                : null,
        },
        summary: {
            days: points.length,
            totalKm,
            totalAh,
            /**
             * The aggregate ratio (total Ah ÷ total km), NOT the mean of the per-day ratios.
             *
             * The per-day ratio is biased low wherever cycle detection resolved only part of
             * a day's discharge: 27 May on the reference battery shows 118 km against a single
             * detected cycle, giving 0.38 Ah/km where the pack really does about 1.2. Averaging
             * those ratios lets an under-detected day count as much as a fully-resolved one.
             * Summing first weights every kilometre equally and is the number to quote.
             */
            avgAhPerKm: totalKm > 0 ? Math.round((totalAh / totalKm) * 1000) / 1000 : null,
            /**
             * Days with kilometres but no resolvable discharge cycle at all — left out of the
             * scatter entirely rather than dragged onto the axis at zero Ah. A non-trivial
             * count here means the scatter is a sample of the period, not a census of it.
             */
            daysWithoutDischarge: distance.buckets.filter(
                (b) => (b.km ?? 0) > 0 && !byDay.has(b.bucket),
            ).length,
        },
    };
}
