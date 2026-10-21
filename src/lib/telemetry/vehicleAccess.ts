/**
 * Tracker ID 181 — server side of the per-vehicle access rule
 * (rules: vehicleAccessRules.ts).
 *
 * The telemetry itself lives on the VPS TimescaleDB (getIotSql); the
 * dealer↔vehicle mapping and the open log live on the main CRM database
 * (`db`). Nothing here touches the VPS.
 */
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { resolveDealerCode } from "@/lib/auth/requireLeadAccess";
import { dealerVehicleNumbers } from "@/lib/telemetry/queries";
import { authFailureStatus, mayOpenVehicle, type VehicleFeed } from "@/lib/telemetry/vehicleAccessRules";

export type TelemetryViewer = {
    id: string;
    role: "ceo" | "dealer";
    /** The dealer code a dealer login acts under; null for the CEO or a dealer without one. */
    dealerCode: string | null;
};

/** requireRole(['ceo','dealer']) plus the dealer code (users.dealer_id, else the approved application's code). */
export async function requireTelemetryViewer(): Promise<TelemetryViewer> {
    const user = await requireRole(["ceo", "dealer"]);
    const role = user.role === "ceo" ? "ceo" : "dealer";
    const dealerCode =
        role === "dealer"
            ? await resolveDealerCode({ id: user.id, role: user.role, dealer_id: user.dealer_id ?? null })
            : null;
    return { id: user.id, role, dealerCode };
}

/**
 * The vehicle numbers a dealer may see, or null for the CEO (= no scope).
 * A dealer with no dealer code gets an empty list — never the whole fleet.
 */
export async function viewerVehicleScope(viewer: TelemetryViewer): Promise<string[] | null> {
    if (viewer.role === "ceo") return null;
    if (!viewer.dealerCode) return [];
    return dealerVehicleNumbers(viewer.dealerCode);
}

export async function viewerMayOpenVehicle(viewer: TelemetryViewer, vehicleNumber: string): Promise<boolean> {
    const scope = await viewerVehicleScope(viewer);
    return mayOpenVehicle({ role: viewer.role, vehicleNumber, mappedVehicleNumbers: scope });
}

/**
 * Record one open of a vehicle feed (allowed or refused) in
 * telemetry_location_access_log (E-347). Never throws: on a database without
 * E-347 the failure goes to the server log and the request is answered as
 * decided.
 */
export async function logVehicleOpen(input: {
    /** Who opened it; id null when there is no user uuid (NBFC test bypass). */
    viewer: { id: string | null; role: string };
    deviceId: string;
    feed: VehicleFeed;
    hours: number | null;
    allowed: boolean;
}): Promise<void> {
    await logVehicleOpens({
        viewer: input.viewer,
        feed: input.feed,
        hours: input.hours,
        allowed: input.allowed,
        entries: [{ deviceId: input.deviceId, vehicleNumber: input.deviceId.trim() || null }],
    });
}

/**
 * Several opens in one INSERT (the fleet map: one row per vehicle shown, see
 * vehicleAccessRules.fleetMapLogEntries). Never throws, like logVehicleOpen.
 */
export async function logVehicleOpens(input: {
    viewer: { id: string | null; role: string };
    feed: VehicleFeed;
    hours: number | null;
    allowed: boolean;
    entries: ReadonlyArray<{ deviceId: string; vehicleNumber: string | null }>;
}): Promise<void> {
    if (input.entries.length === 0) return;
    try {
        const values = input.entries.map(
            (e) => sql`(${input.viewer.id}, ${input.viewer.role}, ${e.deviceId}, ${e.vehicleNumber},
                    ${input.feed}, ${input.hours}, ${input.allowed})`,
        );
        await db.execute(sql`
            INSERT INTO telemetry_location_access_log (user_id, role, device_id, vehicle_number, feed, hours, allowed)
            VALUES ${sql.join(values, sql`, `)}
        `);
    } catch (err) {
        console.error(
            "[telemetry] vehicle open log failed (is E-347 applied?):",
            err instanceof Error ? err.message : err,
        );
    }
}

/**
 * Has this login written a row for `feed` in the last `minutes`? The fleet map
 * refreshes every 30 s; one set of rows per 15 minutes is enough to answer
 * "who looked at these vehicles, and when" without ~120 rows/hour/vehicle.
 * A login with no user id (test bypass) is never throttled.
 */
export async function loggedRecently(viewer: { id: string | null }, feed: VehicleFeed, minutes: number): Promise<boolean> {
    if (!viewer.id) return false;
    try {
        const rows = (await db.execute(sql`
            SELECT 1 FROM telemetry_location_access_log
             WHERE user_id = ${viewer.id} AND feed = ${feed}
               AND opened_at > now() - make_interval(mins => ${minutes})
             LIMIT 1
        `)) as unknown as { rows?: unknown[] } | unknown[];
        const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
        return list.length > 0;
    } catch {
        return false;
    }
}

/**
 * The shared gate of the four per-vehicle feeds: resolve the caller, check the
 * vehicle, write the open log. Returns the viewer, or the response to send
 * (404 'not found' when a dealer asks for a vehicle that is not mapped to it).
 */
export async function requireVehicleFeedAccess(input: {
    deviceId: string;
    feed: VehicleFeed;
    /** Window asked for, after the cap; null for feeds without one. */
    hours: (viewer: TelemetryViewer) => number | null;
}): Promise<{ ok: true; viewer: TelemetryViewer; hours: number | null } | { ok: false; response: NextResponse }> {
    const viewer = await requireTelemetryViewer();
    const hours = input.hours(viewer);
    const allowed = await viewerMayOpenVehicle(viewer, input.deviceId);
    await logVehicleOpen({ viewer, deviceId: input.deviceId, feed: input.feed, hours, allowed });
    if (!allowed) {
        return { ok: false, response: vehicleNotFound() };
    }
    return { ok: true, viewer, hours };
}

export function vehicleNotFound(): NextResponse {
    return NextResponse.json({ success: false, error: { message: "Device not found" } }, { status: 404 });
}

/**
 * Error answer for the telemetry routes: 401 without a session, 403 for a
 * wrong role, 500 otherwise (with the server log line).
 */
export function telemetryErrorResponse(error: unknown, tag: string): NextResponse {
    const status = authFailureStatus(error);
    if (status === 401) {
        return NextResponse.json({ success: false, error: { message: "Please log in" } }, { status: 401 });
    }
    if (status === 403) {
        return NextResponse.json({ success: false, error: { message: "Not allowed" } }, { status: 403 });
    }
    console.error(`[${tag}] Error:`, error);
    const message = error instanceof Error ? error.message : "Server error";
    return NextResponse.json({ success: false, error: { message } }, { status: 500 });
}
