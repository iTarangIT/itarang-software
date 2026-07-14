/**
 * Distance covered inside arbitrary time windows — the per-cycle km behind the
 * discharge scatter, the timeline detail panel, and the charging-spot marker.
 *
 * ## Why this needs calibration
 *
 * `distance_rollup` is the only authoritative distance source, but it is DAILY — it
 * cannot say how far the vehicle went during one discharge cycle inside a day. The GPS
 * chord (haversine between consecutive fixes, geo-sql.ts) has the right time resolution
 * but is a known **lower bound**: at a ~8.5-minute fix cadence it cuts corners, reading
 * ~27% short against the rollup on the reference battery.
 *
 * So each cycle's GPS km is scaled by that day's `rollup ÷ GPS` ratio — the chord
 * provides the *shape* (which cycle got what share of the day), the rollup provides the
 * *scale*. Days whose ratio is outside a sane band (partial tracker outage on one feed)
 * are not trusted to scale anything and fall back to the period-global ratio; when no
 * ratio is computable at all, the raw chord is returned flagged `'gps'` so the UI can
 * present it as a lower bound rather than a measurement.
 *
 * Day boundaries here are UTC (`date_trunc('day', time)`), matching how
 * fetchDistanceTrend buckets `distance_rollup` — NOT the IST boundaries the overnight
 * clustering uses. The two answer different questions; do not unify them.
 */
import { getIotSql } from "@/lib/db/iot";
import {
    buildTimeWindow,
    type ChargingWindowOpts,
    type IotSql,
    type SqlFragment,
} from "./charging-sql";
import { MOVE_MIN_M } from "./geo-math";
import { gpsCTEs } from "./geo-sql";

export interface CycleWindow {
    id: number;
    start: Date;
    end: Date;
}

export type CycleKmSource = "calibrated" | "gps";

export interface CycleKm {
    km: number;
    /** 'gps' = raw chord, a lower bound — the UI must not present it as a measurement. */
    source: CycleKmSource;
}

/**
 * A day's rollup/GPS ratio outside this band means one of the two feeds had a partial
 * outage that day; scaling by it would mint (or erase) kilometres. Expected ratios sit
 * around 1.3-1.4 (the chord undercount), so the band is generous on both sides.
 */
export const CYCLE_KM_FACTOR_MIN = 0.8;
export const CYCLE_KM_FACTOR_MAX = 3.0;

/**
 * Below this, a cycle's "distance" is GPS jitter around a parked vehicle, not a trip.
 * Consumers exclude such cycles from per-km statistics rather than plotting them.
 */
export const MIN_CYCLE_KM = 1;

/**
 * `windows AS (…)` CTE binding the cycle windows as three parallel arrays, so one query
 * covers every cycle instead of a round trip per cycle.
 */
export function windowsCTE(iot: IotSql, windows: CycleWindow[]): SqlFragment {
    const ids = windows.map((w) => w.id);
    const starts = windows.map((w) => w.start);
    const ends = windows.map((w) => w.end);
    return iot`windows AS (
        SELECT * FROM unnest(
            ${ids}::int[], ${starts}::timestamptz[], ${ends}::timestamptz[]
        ) AS w(win_id, start_time, end_time)
    )`;
}

/**
 * Pure calibration: per-cycle GPS km × per-day (or global) rollup/GPS factor.
 *
 * @param cycleDayGpsKm GPS km per (cycle id, UTC day) — one cycle may span days.
 * @param dayGpsKm      GPS km per UTC day over the whole window.
 * @param dayRollupKm   `distance_rollup` km per UTC day.
 */
export function calibrateCycleKm(
    cycleDayGpsKm: Array<{ id: number; day: string; gpsKm: number }>,
    dayGpsKm: ReadonlyMap<string, number>,
    dayRollupKm: ReadonlyMap<string, number>,
): Map<number, CycleKm> {
    // Per-day factors, and the global factor over exactly the days trusted enough to
    // carry one — an untrusted day must not skew the global it falls back to.
    const dayFactor = new Map<string, number>();
    let trustedRollup = 0;
    let trustedGps = 0;
    for (const [day, gps] of dayGpsKm) {
        const rollup = dayRollupKm.get(day);
        if (rollup == null || !(gps > 0)) continue;
        const factor = rollup / gps;
        if (factor < CYCLE_KM_FACTOR_MIN || factor > CYCLE_KM_FACTOR_MAX) continue;
        dayFactor.set(day, factor);
        trustedRollup += rollup;
        trustedGps += gps;
    }
    const globalFactor = trustedGps > 0 ? trustedRollup / trustedGps : null;

    const acc = new Map<number, number>();
    for (const row of cycleDayGpsKm) {
        const factor = dayFactor.get(row.day) ?? globalFactor;
        const km = factor != null ? row.gpsKm * factor : row.gpsKm;
        acc.set(row.id, (acc.get(row.id) ?? 0) + km);
    }

    const source: CycleKmSource = globalFactor != null ? "calibrated" : "gps";
    const out = new Map<number, CycleKm>();
    for (const [id, km] of acc) {
        out.set(id, { km: Math.round(km * 10) / 10, source });
    }
    return out;
}

/** postgres.js returns some numerics as strings; date_trunc as Date. */
const num = (v: unknown): number | null =>
    v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null;

const dayKey = (v: unknown): string => new Date(v as string).toISOString().slice(0, 10);

/**
 * Calibrated km per cycle window. Cycles whose window saw no GPS travel are absent from
 * the result — the caller renders "unknown", never 0.
 */
export async function fetchCycleWindowKm(
    vehicleno: string,
    opts: ChargingWindowOpts,
    windows: CycleWindow[],
): Promise<Map<number, CycleKm>> {
    if (windows.length === 0) return new Map();

    const iot = getIotSql();
    const { timePredicate } = buildTimeWindow(iot, opts);

    const [cycleRows, dayRows, rollupRows] = await Promise.all([
        // GPS km per (cycle, UTC day). An interval's move_m covers (prev_time, time], so a
        // segment belongs to the window its END falls in; sub-MOVE_MIN_M wobble is jitter,
        // not travel (see geo-math.ts).
        iot`
            ${gpsCTEs(iot, vehicleno, timePredicate)},
            ${windowsCTE(iot, windows)}
            SELECT w.win_id,
                   date_trunc('day', s.time) AS day,
                   sum(s.move_m) FILTER (WHERE s.move_m >= ${MOVE_MIN_M}) / 1000.0 AS gps_km
            FROM seg s
            JOIN windows w ON s.time > w.start_time AND s.time <= w.end_time
            WHERE s.dt_s IS NOT NULL
            GROUP BY 1, 2
        ` as unknown as Promise<Array<Record<string, unknown>>>,
        // GPS km per UTC day over the whole window — the denominator of the day factor.
        iot`
            ${gpsCTEs(iot, vehicleno, timePredicate)}
            SELECT date_trunc('day', time) AS day,
                   sum(move_m) FILTER (WHERE move_m >= ${MOVE_MIN_M}) / 1000.0 AS gps_km
            FROM seg
            WHERE dt_s IS NOT NULL
            GROUP BY 1
        ` as unknown as Promise<Array<Record<string, unknown>>>,
        // Same source and day-bucketing as fetchDistanceTrend — the numerator.
        iot`
            SELECT date_trunc('day', time) AS day,
                   sum(distance_km)::float AS km
            FROM distance_rollup
            WHERE vehicleno = ${vehicleno}
              AND bucket_size = 'day'
              ${timePredicate}
            GROUP BY 1
        ` as unknown as Promise<Array<Record<string, unknown>>>,
    ]);

    const cycleDayGpsKm = cycleRows.flatMap((r) => {
        const gpsKm = num(r.gps_km);
        return gpsKm != null && gpsKm > 0
            ? [{ id: Number(r.win_id), day: dayKey(r.day), gpsKm }]
            : [];
    });
    const dayGpsKm = new Map<string, number>();
    for (const r of dayRows) {
        const gpsKm = num(r.gps_km);
        if (gpsKm != null) dayGpsKm.set(dayKey(r.day), gpsKm);
    }
    const dayRollupKm = new Map<string, number>();
    for (const r of rollupRows) {
        const km = num(r.km);
        if (km != null) dayRollupKm.set(dayKey(r.day), km);
    }

    return calibrateCycleKm(cycleDayGpsKm, dayGpsKm, dayRollupKm);
}
