/**
 * GET /api/nbfc/iot/battery/[serialNumber]/soc — E-050 (BRD §6.2.7)
 *
 * Returns the latest SOC/SOH snapshot plus a 3-bucket freshness label for one
 * battery, scoped to the caller's role:
 *   - admin / ceo  -> any serial
 *   - nbfc tenant  -> only serials in its portfolio
 *   - dealer       -> only serials whose iot_devices.dealer_id matches theirs
 *
 * Errors: 404 if the serial does not exist anywhere; 403 if it exists but the
 * caller's scope cannot see it; 401 if no caller is resolved.
 *
 * Response shape:
 *   { serial, soc_percent, soh_percent, last_seen, device_status, freshness }
 *
 * AC1 / AC2 cover this endpoint in the loop tests.
 */
import { NextResponse } from "next/server";
import {
  resolveBatteryActor,
  getDeviceBySerial,
  isSerialAuthorised,
  freshnessForSoc,
  errorToStatus,
} from "@/lib/nbfc/battery-scope";

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

    const device = await getDeviceBySerial(serialNumber);
    if (!device) {
      return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
    }

    const allowed = await isSerialAuthorised(device, actor);
    if (!allowed) {
      return NextResponse.json({ ok: false, error: "FORBIDDEN" }, { status: 403 });
    }

    return NextResponse.json({
      serial: device.serial_number,
      soc_percent: device.soc_percent,
      soh_percent: device.soh_percent,
      last_seen: device.last_seen ? device.last_seen.toISOString() : null,
      device_status: device.device_status,
      freshness: freshnessForSoc(device.last_seen),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: errorToStatus(msg) });
  }
}
