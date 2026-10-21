/**
 * GET /api/nbfc/iot/battery/[serialNumber]/history?from&to&metric — E-050
 * (BRD §6.2.7)
 *
 * Returns a time-ordered point series for one battery and one metric.
 *
 * Data plane: telemetry lives on the IoT VPS Postgres, NOT in the app DB.
 * The whole Battery Monitoring portal (list page, detail drawer panels)
 * sources telemetry from the VPS via `getIotSql()`, keyed by `vehicleno`.
 * This endpoint does the same — earlier it read the app-DB `telemetry_events`
 * / `telemetry_daily_summary` tables, which the NBFC seed never populates, so
 * every chart resolved to NOT_FOUND / empty.
 *
 * Source table depends on the metric:
 *   - metric=soc | soh -> telemetry_battery, aggregated to a daily average
 *   - metric=gps       -> telemetry_gps      (per-fix lat/lon)
 *   - metric=daily_km  -> daily_distance_per_vehicle (one row per day)
 *
 * Response shape:
 *   { serial, metric, points: [{ date: ISO|YYYY-MM-DD, value: number | { lat, lng } }] }
 * Points are ordered ASCENDING by date — this is the contract AC4 asserts.
 *
 * Dealer logins (tracker ID 181, 18 Oct follow-up): the battery must be mapped
 * to the dealer (device_battery_map, same as the telemetry fleet — see
 * battery-scope dealerMayOpenSerial); a GPS trail is trimmed to the last
 * 7 days (`capped: true` in the response when trimmed); and every dealer open,
 * allowed or refused, is written to telemetry_location_access_log
 * (feed 'battery_gps' for metric=gps, else 'battery_history'). NBFC, admin and
 * CEO behaviour is unchanged.
 */
import { NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";
import { getIotSql } from "@/lib/db/iot";
import { logVehicleOpen } from "@/lib/telemetry/vehicleAccess";
import { DEALER_MAX_FEED_HOURS, capDealerRange } from "@/lib/telemetry/vehicleAccessRules";
import {
  resolveBatteryActor,
  authoriseSerial,
  errorToStatus,
} from "@/lib/nbfc/battery-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "from must be YYYY-MM-DD" }),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "to must be YYYY-MM-DD" }),
  metric: z.enum(["soc", "soh", "daily_km", "gps"]),
});

type Point = { date: string; value: number | { lat: number; lng: number } | null };

/** postgres.js sets `code` on driver errors; 42P01 = undefined_table. */
function isMissingTable(err: unknown): boolean {
  return (err as { code?: string } | null | undefined)?.code === "42P01";
}

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

    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse({
      from: url.searchParams.get("from") ?? "",
      to: url.searchParams.get("to") ?? "",
      metric: url.searchParams.get("metric") ?? "",
    });
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "INVALID_QUERY", details: parsed.error.flatten() },
        { status: 422 },
      );
    }
    const { from, to, metric } = parsed.data;

    // Existence + authorisation against the loan plane (the registry plane,
    // iot_devices, is empty in NBFC-seeded environments).
    const auth = await authoriseSerial(serialNumber, actor);

    // Range bounds — inclusive of `from` 00:00 UTC and `to` end-of-day. A
    // dealer's GPS trail is trimmed to the last 7 days.
    const range = capDealerRange({
      role: metric === "gps" ? actor.role : "uncapped",
      from: new Date(`${from}T00:00:00.000Z`),
      to: new Date(`${to}T23:59:59.999Z`),
      now: new Date(),
    });

    if (actor.role === "dealer") {
      await logVehicleOpen({
        viewer: { id: actor.user_id ?? null, role: "dealer" },
        deviceId: serialNumber,
        feed: metric === "gps" ? "battery_gps" : "battery_history",
        hours: metric === "gps" ? DEALER_MAX_FEED_HOURS : null,
        allowed: auth === "ok",
      });
    }

    if (auth === "not_found") {
      return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
    }
    if (auth === "forbidden") {
      return NextResponse.json({ ok: false, error: "FORBIDDEN" }, { status: 403 });
    }

    const fromDate = range.from;
    const toDate = range.to;
    if (range.empty) {
      return NextResponse.json({ serial: serialNumber, metric, points: [], ...(range.capped ? { capped: true } : {}) });
    }

    const iotSql = getIotSql();
    let points: Point[] = [];

    try {
      if (metric === "soc" || metric === "soh") {
        // Daily average from telemetry_battery — collapses ~1k packets/day
        // into one trend point per day.
        const rows =
          metric === "soc"
            ? await iotSql<Array<{ day: string; value: number | null }>>`
                SELECT to_char(date_trunc('day', time), 'YYYY-MM-DD') AS day,
                       round(avg(soc_pct)::numeric, 1)::float AS value
                FROM telemetry_battery
                WHERE vehicleno = ${serialNumber}
                  AND time >= ${fromDate} AND time <= ${toDate}
                  AND soc_pct IS NOT NULL
                GROUP BY 1 ORDER BY 1`
            : await iotSql<Array<{ day: string; value: number | null }>>`
                SELECT to_char(date_trunc('day', time), 'YYYY-MM-DD') AS day,
                       round(avg(soh_pct)::numeric, 1)::float AS value
                FROM telemetry_battery
                WHERE vehicleno = ${serialNumber}
                  AND time >= ${fromDate} AND time <= ${toDate}
                  AND soh_pct IS NOT NULL
                GROUP BY 1 ORDER BY 1`;
        points = rows.map((r) => ({
          date: r.day,
          value: r.value == null ? null : Number(r.value),
        }));
      } else if (metric === "gps") {
        const rows = await iotSql<
          Array<{ time: string; lat: number | null; lon: number | null }>
        >`
          SELECT time, lat, lon
          FROM telemetry_gps
          WHERE vehicleno = ${serialNumber}
            AND time >= ${fromDate} AND time <= ${toDate}
            AND lat IS NOT NULL AND lon IS NOT NULL
          ORDER BY time`;
        points = rows.map((r) => ({
          date: new Date(r.time).toISOString(),
          value:
            r.lat != null && r.lon != null
              ? { lat: Number(r.lat), lng: Number(r.lon) }
              : null,
        }));
      } else {
        // metric === "daily_km" → daily_distance_per_vehicle.km
        const rows = await iotSql<Array<{ day: string; value: number | null }>>`
          SELECT to_char(day, 'YYYY-MM-DD') AS day, km::float AS value
          FROM daily_distance_per_vehicle
          WHERE vehicleno = ${serialNumber}
            AND day >= ${from}::date AND day <= ${to}::date
          ORDER BY day`;
        points = rows.map((r) => ({
          date: r.day,
          value: r.value == null ? null : Number(r.value),
        }));
      }
    } catch (e) {
      // A missing VPS table degrades to an empty series, not a 500 — the
      // chart then renders its quiet "no telemetry history" notice.
      if (!isMissingTable(e)) throw e;
      points = [];
    }

    return NextResponse.json({ serial: serialNumber, metric, points, ...(range.capped ? { capped: true } : {}) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: errorToStatus(msg) });
  }
}
