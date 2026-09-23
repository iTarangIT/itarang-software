/**
 * Pure arithmetic behind the Fleet Monitor page (/monitor).
 *
 * No I/O lives here on purpose: every number the page shows is derived by these
 * functions from rows the query layer hands over, so the whole of the page's
 * logic is unit-testable without a database. See
 * src/lib/telemetry/__tests__/monitor-math.test.ts.
 *
 * FRESHNESS COMES FROM last_battery_at / last_gps_at, NEVER last_seen.
 * `vehicle_state.last_seen` is stamped every poll cycle whether or not the
 * device answered — measured 2026-08-08, all 331 vehicles read under an hour
 * old while 14 of them had not sent battery telemetry for over 24 hours and one
 * had been silent 99 days. Any uptime metric built on last_seen reads a false
 * 100%. These two columns are the only honest freshness signals on the table;
 * note there is no third, CAN channel — queries.ts exposes `last_can_at` as an
 * alias of last_battery_at.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Newest to oldest. `never` is its own state, not an extreme of the scale. */
export type SilenceBand = "under_1h" | "1h_24h" | "1d_7d" | "over_7d" | "never";

export const SILENCE_BANDS: readonly SilenceBand[] = [
    "under_1h",
    "1h_24h",
    "1d_7d",
    "over_7d",
    "never",
] as const;

export const SILENCE_BAND_LABELS: Record<SilenceBand, string> = {
    under_1h: "< 1h",
    "1h_24h": "1–24h",
    "1d_7d": "1–7d",
    over_7d: "> 7d",
    never: "Never",
};

export type SocBand = "0-20" | "20-40" | "40-60" | "60-80" | "80-100";

export const SOC_BANDS: readonly SocBand[] = ["0-20", "20-40", "40-60", "60-80", "80-100"] as const;

/** One row of `vehicle_state`, narrowed to the columns this page reads. */
export type VehicleStateRow = {
    vehicleno: string;
    online: boolean | null;
    soc_pct: number | null;
    last_battery_at: string | Date | null;
    last_gps_at: string | Date | null;
    open_alert_count: number | null;
};

export type AttentionRow = {
    vehicleno: string;
    ageMs: number;
    lastBatteryAgeMs: number | null;
    lastGpsAgeMs: number | null;
    soc_pct: number | null;
    open_alert_count: number;
};

export type MonitorSummary = {
    fleetSize: number;
    liveNow: number;
    /** liveNow as a percentage of the fleet, one decimal place. */
    livePct: number;
    reportedLast24h: number;
    silentOver24h: number;
    neverReported: number;
    /** Age of the newest signal anywhere in the fleet; null if nothing ever reported. */
    newestSignalAgeMs: number | null;
    silence: Record<"battery" | "gps", Record<SilenceBand, number>>;
    soc: {
        buckets: Record<SocBand, number>;
        below20: number;
        withReading: number;
        avg: number | null;
    };
    attention: AttentionRow[];
};

/**
 * Milliseconds since `ts`, or null when there is no usable timestamp.
 *
 * A timestamp slightly in the future (the poller box and this process do not
 * share a clock) is clamped to 0 rather than becoming a negative age, which
 * would otherwise sort to the top of the attention table as the "oldest".
 */
function ageMs(ts: string | Date | null | undefined, now: Date): number | null {
    if (ts === null || ts === undefined) return null;
    const ms = ts instanceof Date ? ts.getTime() : Date.parse(ts);
    if (!Number.isFinite(ms)) return null;
    return Math.max(0, now.getTime() - ms);
}

export function silenceBucket(
    ts: string | Date | null | undefined,
    now: Date,
): SilenceBand {
    const age = ageMs(ts, now);
    if (age === null) return "never";
    if (age <= HOUR_MS) return "under_1h";
    if (age <= DAY_MS) return "1h_24h";
    if (age <= 7 * DAY_MS) return "1d_7d";
    return "over_7d";
}

/**
 * Null for a missing reading — deliberately NOT 0. A silent sensor and a flat
 * pack are different operational events, and only one of them needs a van.
 */
export function socBucket(pct: number | null | undefined): SocBand | null {
    if (pct === null || pct === undefined || !Number.isFinite(pct)) return null;
    const clamped = Math.min(100, Math.max(0, pct));
    if (clamped < 20) return "0-20";
    if (clamped < 40) return "20-40";
    if (clamped < 60) return "40-60";
    if (clamped < 80) return "60-80";
    return "80-100";
}

export type FreshnessPill = {
    kind: "live" | "stale" | "frozen" | "never";
    label: string;
};

/**
 * Grades the fleet's newest signal. Thresholds match the LIVE/FROZEN call that
 * scripts/check-iot-live.mjs already makes, so the page and the CLI agree.
 */
export function freshnessPill(newestAgeMs: number | null): FreshnessPill {
    if (newestAgeMs === null) return { kind: "never", label: "NO DATA" };
    if (newestAgeMs <= 2 * HOUR_MS) return { kind: "live", label: "LIVE" };
    if (newestAgeMs <= DAY_MS) return { kind: "stale", label: "STALE" };
    return { kind: "frozen", label: "FROZEN" };
}

/**
 * Floors rather than rounds, so 90s reads "1 min ago" the way every relative-time
 * convention has it. The precision that matters for staleness is carried by
 * freshnessPill()'s 2h/24h thresholds, not by this label.
 */
export function relativeAge(ms: number | null): string {
    if (ms === null) return "—";
    if (ms < 45_000) return "just now";
    if (ms < HOUR_MS) return `${Math.floor(ms / 60_000)} min ago`;
    if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)} h ago`;
    return `${Math.floor(ms / DAY_MS)} d ago`;
}

function emptyBands(): Record<SilenceBand, number> {
    return { under_1h: 0, "1h_24h": 0, "1d_7d": 0, over_7d: 0, never: 0 };
}

function emptySocBuckets(): Record<SocBand, number> {
    return { "0-20": 0, "20-40": 0, "40-60": 0, "60-80": 0, "80-100": 0 };
}

/**
 * Everything the page's tiles and charts need, from one pass over vehicle_state.
 *
 * `reportedLast24h`, `silentOver24h` and `neverReported` are a partition of the
 * fleet — every vehicle lands in exactly one, so the tiles always sum to the
 * fleet size. A vehicle counts as reporting if EITHER channel is fresh; losing
 * one of the two is a degradation the silence chart shows, not an outage.
 */
export function summariseVehicleStates(
    rows: VehicleStateRow[],
    now: Date,
    opts: { attentionLimit?: number } = {},
): MonitorSummary {
    const attentionLimit = opts.attentionLimit ?? 15;

    const silence = { battery: emptyBands(), gps: emptyBands() };
    const socBuckets = emptySocBuckets();

    let liveNow = 0;
    let reportedLast24h = 0;
    let silentOver24h = 0;
    let neverReported = 0;
    let newestSignalAgeMs: number | null = null;
    let socSum = 0;
    let socCount = 0;
    let below20 = 0;

    const candidates: AttentionRow[] = [];

    for (const row of rows) {
        const batteryAge = ageMs(row.last_battery_at, now);
        const gpsAge = ageMs(row.last_gps_at, now);

        silence.battery[silenceBucket(row.last_battery_at, now)] += 1;
        silence.gps[silenceBucket(row.last_gps_at, now)] += 1;

        if (row.online) liveNow += 1;

        // Newest of the two channels: the vehicle is as fresh as its freshest link.
        const ages = [batteryAge, gpsAge].filter((a): a is number => a !== null);
        const newest = ages.length ? Math.min(...ages) : null;

        if (newest === null) {
            neverReported += 1;
        } else {
            if (newest > DAY_MS) silentOver24h += 1;
            else reportedLast24h += 1;

            if (newestSignalAgeMs === null || newest < newestSignalAgeMs) {
                newestSignalAgeMs = newest;
            }

            // Anything quiet for over an hour is a candidate for the attention
            // table. The never-reported are excluded: they have their own tile,
            // and they are overwhelmingly devices that were never installed
            // rather than ones that stopped working.
            if (newest > HOUR_MS) {
                candidates.push({
                    vehicleno: row.vehicleno,
                    ageMs: newest,
                    lastBatteryAgeMs: batteryAge,
                    lastGpsAgeMs: gpsAge,
                    soc_pct: row.soc_pct,
                    open_alert_count: row.open_alert_count ?? 0,
                });
            }
        }

        const band = socBucket(row.soc_pct);
        if (band !== null) {
            socBuckets[band] += 1;
            socSum += Math.min(100, Math.max(0, row.soc_pct as number));
            socCount += 1;
            if (band === "0-20") below20 += 1;
        }
    }

    const fleetSize = rows.length;

    return {
        fleetSize,
        liveNow,
        livePct: fleetSize === 0 ? 0 : Math.round((liveNow / fleetSize) * 1000) / 10,
        reportedLast24h,
        silentOver24h,
        neverReported,
        newestSignalAgeMs,
        silence,
        soc: {
            buckets: socBuckets,
            below20,
            withReading: socCount,
            avg: socCount === 0 ? null : Math.round((socSum / socCount) * 10) / 10,
        },
        attention: candidates.sort((a, b) => b.ageMs - a.ageMs).slice(0, attentionLimit),
    };
}
