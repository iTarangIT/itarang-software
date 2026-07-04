/**
 * GET /api/nbfc/iot/battery/[serialNumber]/state — E-050 (BRD §6.2.7)
 *
 * Returns the latest telemetry snapshot for one battery plus a 5-bucket
 * data_freshness label. Powers the Telemetry tab in CaseWorkspaceSheet and any
 * operator-side debug surface that needs every column.
 *
 * Sources (in priority order):
 *   1. CRM iot_devices         — registry (IMEI, model, dealer_id, etc.)
 *   2. VPS vehicle_state       — live SoC / SoH / pack_temp_c / last_gps_at
 *   3. VPS battery_health      — cycles_since_install (charge cycles)
 *
 * The endpoint exists in two response shapes for backwards compatibility:
 *   - body.device.*                          (legacy E-050 shape — full row)
 *   - body.soc_pct / .soh_pct / .charge_cycles / .pack_temp_c / .last_seen
 *                                            (flat shape consumed by the
 *                                             CaseWorkspaceSheet TelemetryTab)
 *
 * Authorisation via authoriseSerial(): a serial is "in scope" if EITHER the
 * iot_devices registry has it OR an nbfc_loans row in the caller's tenant has
 * vehicleno=serial. This handles the NBFC-direct seed where iot_devices is
 * empty but loans exist.
 */
import { NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import {
  resolveBatteryActor,
  getDeviceBySerial,
  authoriseSerial,
  classifyFreshness,
  errorToStatus,
} from "@/lib/nbfc/battery-scope";
import { getVehicleStates, getBatteryHealth } from "@/lib/db/iot-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ serialNumber: string }> },
) {
  try {
    const { serialNumber } = await ctx.params;
    if (!serialNumber) {
      return NextResponse.json({ ok: false, error: "MISSING_SERIAL" }, { status: 400 });
    }
    const actor = await resolveBatteryActor(req.headers);

    const auth = await authoriseSerial(serialNumber, actor);
    if (auth === "not_found") {
      return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
    }
    if (auth === "forbidden") {
      return NextResponse.json({ ok: false, error: "FORBIDDEN" }, { status: 403 });
    }

    const device = await getDeviceBySerial(serialNumber);

    // VPS live telemetry. Empty array when the VPS has never seen this serial
    // (e.g. a freshly-registered IoT device with no packets yet).
    const vpsStates = await getVehicleStates([serialNumber]).catch(() => []);
    const vps = vpsStates[0] ?? null;

    // Charge cycles — only the aggregator table tracks this directly.
    const health = await getBatteryHealth(serialNumber).catch(() => null);

    const soc_pct = vps?.soc_pct ?? device?.soc_percent ?? null;
    const soh_pct = vps?.soh_pct ?? device?.soh_percent ?? null;
    const pack_temp_c =
      vps?.pack_temp_c ??
      (device?.temperature_c != null ? Number(device.temperature_c) : null);
    const charge_cycles =
      health?.cycles_since_install ?? device?.charge_cycles ?? null;
    const last_seen =
      vps?.last_gps_at ?? device?.last_seen ?? null;

    return NextResponse.json({
      // Flat snapshot (CaseWorkspaceSheet / TelemetryTab consumer).
      soc_pct,
      soh_pct,
      pack_temp_c,
      charge_cycles,
      last_seen: last_seen ? last_seen.toISOString() : null,
      last_gps_at: vps?.last_gps_at ? vps.last_gps_at.toISOString() : null,

      // Legacy wrapped shape — preserved when an iot_devices row exists.
      device: device
        ? {
            ...device,
            last_seen: device.last_seen ? device.last_seen.toISOString() : null,
            gps_updated_at: device.gps_updated_at
              ? device.gps_updated_at.toISOString()
              : null,
            first_usage_at: device.first_usage_at
              ? device.first_usage_at.toISOString()
              : null,
            registered_at: device.registered_at.toISOString(),
            updated_at: device.updated_at.toISOString(),
          }
        : null,
      data_freshness: classifyFreshness(last_seen),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: errorToStatus(msg) });
  }
}
