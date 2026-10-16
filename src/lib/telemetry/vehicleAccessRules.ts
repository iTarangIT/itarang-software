/**
 * Tracker ID 181 — who may open one vehicle's data feeds (details with the
 * owner's name, GPS trail, trips, battery readings), and how much of it.
 *
 * Pure: no I/O, so the rules are unit-tested (src/lib/telemetry/__tests__/
 * vehicleAccessRules.test.ts). The I/O wrapper is vehicleAccess.ts.
 *
 * Decision (Kartik, 14 Oct): a dealer sees a vehicle only if it is mapped to
 * that dealer (device_battery_map.dealer_id, active, the same lookup the fleet
 * list uses); otherwise the answer is "not found", so a dealer cannot even
 * learn that another dealer's vehicle exists. The CEO is unchanged.
 */

/** The four per-vehicle feeds; stored in telemetry_location_access_log.feed. */
export type VehicleFeed = "details" | "gps" | "trips" | "readings";

/** GPS / readings window when the caller does not ask for one. */
export const DEFAULT_FEED_HOURS = 24;
/** Longest GPS / readings window a dealer may ask for: 7 days. */
export const DEALER_MAX_FEED_HOURS = 168;

export const DEFAULT_TRIP_LIMIT = 20;
export const MAX_TRIP_LIMIT = 100;

/**
 * The ?hours= window for the GPS and readings feeds. Anything that is not a
 * positive whole number falls back to the default; a dealer is capped at
 * 7 days. The CEO keeps the uncapped window (fleet investigations).
 */
export function feedHours(raw: string | null | undefined, role: string): number {
    const n = Number.parseInt(String(raw ?? ""), 10);
    const hours = Number.isFinite(n) && n > 0 ? n : DEFAULT_FEED_HOURS;
    return role === "dealer" ? Math.min(hours, DEALER_MAX_FEED_HOURS) : hours;
}

/** The ?limit= for the trips feed: 1..100, default 20. */
export function tripLimit(raw: string | null | undefined): number {
    const n = Number.parseInt(String(raw ?? ""), 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_TRIP_LIMIT;
    return Math.min(n, MAX_TRIP_LIMIT);
}

/**
 * May this caller open this vehicle? CEO: always. Dealer: only when the vehicle
 * number is among the vehicles mapped to its dealer code. A dealer with no
 * dealer code has no vehicles. Any other role: never (the routes already
 * refuse them with 403 before this is asked).
 */
export function mayOpenVehicle(input: {
    role: string;
    vehicleNumber: string;
    mappedVehicleNumbers: readonly string[] | null;
}): boolean {
    if (input.role === "ceo") return true;
    if (input.role !== "dealer") return false;
    const v = input.vehicleNumber.trim();
    if (!v || !input.mappedVehicleNumbers) return false;
    return input.mappedVehicleNumbers.some((m) => m.trim() === v);
}

/**
 * The HTTP status for an auth failure thrown by requireRole(): a missing
 * session surfaces as Next's NEXT_REDIRECT throw (requireAuth redirects to
 * /login) → 401; a wrong role carries status 403. Null for anything else
 * (a real server error).
 */
export function authFailureStatus(err: unknown): 401 | 403 | null {
    if (typeof err !== "object" || err === null) return null;
    const digest = (err as { digest?: unknown }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) return 401;
    const status = (err as { status?: unknown }).status;
    if (status === 401 || status === 403) return status;
    return null;
}

/**
 * The vehicle number inside an alert id (`<vehicleno>|<alert_type>|<epoch>`,
 * built by queries.ts buildAlertId). Null when the id is malformed.
 */
export function alertVehicleNumber(alertId: unknown): string | null {
    if (typeof alertId !== "string") return null;
    const [vehicleNo] = alertId.split("|");
    return vehicleNo && vehicleNo.trim() ? vehicleNo.trim() : null;
}
