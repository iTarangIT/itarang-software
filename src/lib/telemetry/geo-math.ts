/**
 * Geospatial primitives for the battery location analytics.
 *
 * Pure, so vitest covers them without a database. The SQL in geo-sql.ts mirrors haversine()
 * and the grid, exactly as charging-math.ts mirrors the Ah integral — if the two ever disagree,
 * these are what say which one is wrong.
 *
 * ## Why dwell is measured by displacement, not by speed
 *
 * The obvious way to find a parked vehicle is `speed_kph = 0`. On this fleet that finds almost
 * nothing: only **61 of 8,765** GPS fixes on the reference battery report zero speed (0.7%), so
 * an e-rickshaw that plainly parks overnight looks like it is moving 99.3% of the time. The
 * tracker simply does not emit a clean zero.
 *
 * Position does not lie. Two consecutive fixes within DWELL_RADIUS_M of each other mean the
 * vehicle did not go anywhere between them, and the elapsed time between them is dwell. That
 * also handles the case where the tracker sleeps while parked — the silence *is* the dwell,
 * because the fix before the gap and the fix after it are in the same place.
 */

function envNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw == null || raw.trim() === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Two fixes closer than this are the same place. 100 m is comfortably above consumer-GPS
 * scatter when stationary (typically 5-20 m, worse under trees or between buildings) and well
 * below the distance any real trip covers.
 */
export const DWELL_RADIUS_M = envNumber("TELEMETRY_DWELL_RADIUS_M", 100);

/**
 * A displacement below this is GPS jitter, not travel, and must not accrue distance.
 *
 * Without it, a vehicle parked for a week accumulates kilometres from its own noise: a 10 m
 * wobble every 4 minutes is 3.6 km/day of phantom travel, and it would light up the heat map
 * brightest exactly where the vehicle never moved.
 */
export const MOVE_MIN_M = envNumber("TELEMETRY_MOVE_MIN_M", 30);

/**
 * Dwell across a gap longer than this is *inferred*, not observed.
 *
 * The vehicle was at that spot before the gap and at that spot after it, so it very probably
 * stayed — but we did not watch. Reported separately so a 10-day tracker outage cannot quietly
 * become "10 days parked here" presented as a measurement.
 */
export const DWELL_TRUST_GAP_S = envNumber("TELEMETRY_DWELL_TRUST_GAP_S", 6 * 3600);

/** Hours (IST) that count as overnight, for inferring where the vehicle sleeps. */
export const NIGHT_START_HOUR = envNumber("TELEMETRY_NIGHT_START_HOUR", 22);
export const NIGHT_END_HOUR = envNumber("TELEMETRY_NIGHT_END_HOUR", 5);

/** Grid cell for clustering, in degrees. 0.001° ≈ 111 m of latitude. */
export const GRID_DEG = 0.001;

/**
 * Fewest DISTINCT charge sessions a grid cell must host before it can be called "the
 * charging spot". One session at a place is an anecdote; a pattern needs repetition.
 */
export const CHARGING_SPOT_MIN_SESSIONS = envNumber("TELEMETRY_CHARGING_SPOT_MIN_SESSIONS", 2);

/**
 * Fewest distinct nights before a non-home cluster is offered as the secondary overnight
 * place. Same reasoning: one night somewhere is a stopover, not a pattern.
 */
export const SECONDARY_OVERNIGHT_MIN_NIGHTS = envNumber(
    "TELEMETRY_SECONDARY_OVERNIGHT_MIN_NIGHTS",
    2,
);

const EARTH_RADIUS_M = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. Mirrored by the haversine expression in geo-sql.ts. */
export function haversineM(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
): number {
    const dLat = rad(lat2 - lat1);
    const dLon = rad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Snap a coordinate to the clustering grid. */
export function snapToGrid(lat: number, lon: number, cell = GRID_DEG) {
    return {
        lat: Math.round(lat / cell) * cell,
        lon: Math.round(lon / cell) * cell,
    };
}

/**
 * Is this interval the vehicle sitting still?
 *
 * Deliberately ignores `speed_kph` — see the header. Displacement is the evidence.
 */
export function isDwell(displacementM: number): boolean {
    return displacementM < DWELL_RADIUS_M;
}

/** Is this interval real travel, or GPS noise around a stationary vehicle? */
export function isTravel(displacementM: number): boolean {
    return displacementM >= MOVE_MIN_M;
}

/** Was this interval actually observed, or is its duration an assumption across a gap? */
export function isObserved(dtSeconds: number): boolean {
    return dtSeconds <= DWELL_TRUST_GAP_S;
}

/** Overnight in IST, wrapping midnight (22:00 → 05:00). */
export function isNightHour(hourIst: number): boolean {
    return NIGHT_START_HOUR > NIGHT_END_HOUR
        ? hourIst >= NIGHT_START_HOUR || hourIst < NIGHT_END_HOUR
        : hourIst >= NIGHT_START_HOUR && hourIst < NIGHT_END_HOUR;
}

/**
 * The charging spot: the grid cell with the most stationary time inside detected
 * charge-cycle windows, provided enough distinct sessions happened there. Charging is
 * inferred from rising SOC (the remote `charging` flag is never populated), so the
 * windows come from the charge-cycle aggregate, never from a flag.
 */
export function pickChargingCluster<
    T extends { chargeHours: number; chargeSessions: number },
>(cells: T[]): T | null {
    let best: T | null = null;
    for (const cell of cells) {
        if (cell.chargeSessions < CHARGING_SPOT_MIN_SESSIONS) continue;
        if (best == null || cell.chargeHours > best.chargeHours) best = cell;
    }
    return best;
}

/**
 * The SECONDARY overnight place: ranked next by night hours after home, excluding home's
 * own cell, with the nights floor above. Rank-based rather than recency-based on purpose —
 * a recency definition flaps between refreshes; a ranking is stable and honestly labelled
 * "secondary".
 */
export function pickSecondaryOvernight<
    T extends { lat: number; lon: number; nightHours: number; nights: number },
>(dwell: T[], home: { lat: number; lon: number } | null): T | null {
    let best: T | null = null;
    for (const d of dwell) {
        if (d.nights < SECONDARY_OVERNIGHT_MIN_NIGHTS) continue;
        if (home && d.lat === home.lat && d.lon === home.lon) continue;
        if (best == null || d.nightHours > best.nightHours) best = d;
    }
    return best;
}

/** The active gates, so the UI can explain what it clustered and why. */
export function geoGates() {
    return {
        dwellRadiusM: DWELL_RADIUS_M,
        moveMinM: MOVE_MIN_M,
        dwellTrustGapS: DWELL_TRUST_GAP_S,
        nightStartHour: NIGHT_START_HOUR,
        nightEndHour: NIGHT_END_HOUR,
        gridDeg: GRID_DEG,
        chargingSpotMinSessions: CHARGING_SPOT_MIN_SESSIONS,
        secondaryOvernightMinNights: SECONDARY_OVERNIGHT_MIN_NIGHTS,
    };
}
