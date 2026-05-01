/**
 * GET /api/nbfc/iot/battery/[serialNumber]/state — E-050 (BRD §6.2.7)
 *
 * Returns the full iot_devices row for one battery plus a 5-bucket
 * data_freshness label. Used by the NBFC battery-detail drawer (Section 6.2)
 * and any operator-side debug surface that needs every column.
 *
 * AC3 covers this endpoint.
 */
import { NextResponse } from "next/server";
import {
  resolveBatteryActor,
  getDeviceBySerial,
  isSerialAuthorised,
  classifyFreshness,
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
      device: {
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
      },
      data_freshness: classifyFreshness(device.last_seen),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: errorToStatus(msg) });
  }
}
