/**
 * GET /api/nbfc/iot/battery/[serialNumber]/history?from&to&metric — E-050
 * (BRD §6.2.7)
 *
 * Returns a time-ordered point series for one battery and one metric. Source
 * table depends on the metric:
 *   - metric=soc | soh | gps -> telemetry_events  (per-packet)
 *   - metric=daily_km        -> telemetry_daily_summary  (one row per day)
 *
 * Per BRD non_functional: "history endpoint metric values are derived from
 * telemetry_events / telemetry_daily_summary depending on metric."
 *
 * Response shape:
 *   { serial, metric, points: [{ date: ISO, value: number | { lat, lng } }] }
 * Points are ordered ASCENDING by date — this is the contract AC4 asserts.
 *
 * AC4 covers this endpoint.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import {
  telemetryEvents,
  telemetryDailySummary,
} from "@/lib/db/schema";
import {
  resolveBatteryActor,
  getDeviceBySerial,
  isSerialAuthorised,
  errorToStatus,
} from "@/lib/nbfc/battery-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "from must be YYYY-MM-DD" }),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "to must be YYYY-MM-DD" }),
  metric: z.enum(["soc", "soh", "daily_km", "gps"]),
});

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

    const device = await getDeviceBySerial(serialNumber);
    if (!device) {
      return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
    }

    const allowed = await isSerialAuthorised(device, actor);
    if (!allowed) {
      return NextResponse.json({ ok: false, error: "FORBIDDEN" }, { status: 403 });
    }

    // Range bounds — inclusive of `from` 00:00 UTC and exclusive of `to`
    // (treated as a date, so we extend to end-of-day to cover same-day reads).
    const fromDate = new Date(`${from}T00:00:00.000Z`);
    const toDate = new Date(`${to}T23:59:59.999Z`);

    type Point = { date: string; value: number | { lat: number; lng: number } | null };
    let points: Point[] = [];

    if (metric === "soc" || metric === "soh" || metric === "gps") {
      const rows = await db
        .select({
          device_time: telemetryEvents.device_time,
          soc_percent: telemetryEvents.soc_percent,
          soh_percent: telemetryEvents.soh_percent,
          gps_lat: telemetryEvents.gps_lat,
          gps_lng: telemetryEvents.gps_lng,
        })
        .from(telemetryEvents)
        .where(
          and(
            eq(telemetryEvents.serial_number, serialNumber),
            gte(telemetryEvents.device_time, fromDate),
            lte(telemetryEvents.device_time, toDate),
          ),
        )
        .orderBy(asc(telemetryEvents.device_time));

      points = rows.map((r) => {
        const date = r.device_time.toISOString();
        if (metric === "soc") return { date, value: r.soc_percent ?? null };
        if (metric === "soh") return { date, value: r.soh_percent ?? null };
        // metric === "gps"
        const lat = r.gps_lat == null ? null : Number(r.gps_lat);
        const lng = r.gps_lng == null ? null : Number(r.gps_lng);
        return {
          date,
          value: lat != null && lng != null ? { lat, lng } : null,
        };
      });
    } else {
      // metric === "daily_km" → telemetry_daily_summary.total_km
      const rows = await db
        .select({
          summary_date: telemetryDailySummary.summary_date,
          total_km: telemetryDailySummary.total_km,
        })
        .from(telemetryDailySummary)
        .where(
          and(
            eq(telemetryDailySummary.serial_number, serialNumber),
            gte(telemetryDailySummary.summary_date, from),
            lte(telemetryDailySummary.summary_date, to),
          ),
        )
        .orderBy(asc(telemetryDailySummary.summary_date));

      points = rows.map((r) => ({
        date: typeof r.summary_date === "string" ? r.summary_date : String(r.summary_date),
        value: r.total_km == null ? null : Number(r.total_km),
      }));
    }

    return NextResponse.json({ serial: serialNumber, metric, points });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: errorToStatus(msg) });
  }
}
