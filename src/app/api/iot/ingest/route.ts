/**
 * E-046 — POST /api/iot/ingest
 *
 * Telemetry ingestion API for IoT batteries (BRD §6.2.3). Devices POST a
 * telemetry packet at configurable intervals; the gateway:
 *
 *   1. Authenticates the device via X-Device-IMEI + X-Device-Token (an HS256
 *      JWT signed with IOT_DEVICE_TOKEN_SECRET; iss = imeiId).
 *   2. Validates the request body against the BRD-defined zod schema.
 *   3. Looks up the inventory row by serialNumber to confirm the asset exists
 *      AND is iot-enabled (logical FK — no DB constraint per BRD non-functional
 *      requirement on write throughput).
 *   4. Rejects packets whose device timestamp is more than ±5 minutes off
 *      server UTC ("stale-packet" guard).
 *   5. INSERT one row into telemetry_events.
 *   6. UPDATE iot_devices: cached SOC/SOH/voltage/temperature/GPS/BMS, mark
 *      device_status='online', stamp last_seen with the device timestamp.
 *   7. UPSERT telemetry_daily_summary for (serial_number, date(timestamp)) —
 *      incrementing packets_received and bms_faults, refreshing avg/min/max
 *      aggregates from the day's telemetry_events.
 *   8. Alert-rule evaluation (E-049) is a follow-up unit; not invoked here.
 *
 * Test bypass: when NBFC_TEST_BYPASS is set and the request carries
 *   x-nbfc-test-bypass = NBFC_TEST_BYPASS_SECRET, the JWT verification is
 *   skipped — trusting the X-Device-IMEI header. This mirrors the loop-test
 *   pattern used by other NBFC routes.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, sql as dsql } from "drizzle-orm";
import * as crypto from "node:crypto";
import { db } from "@/lib/db";
import {
  iotDevices,
  inventory,
  telemetryEvents,
  telemetryDailySummary,
} from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IngestBody = z.object({
  serialNumber: z.string().min(1).max(50),
  imeiId: z.string().regex(/^\d{15,20}$/),
  timestamp: z.string().datetime(),
  soc_percent: z.number().int().min(0).max(100),
  soh_percent: z.number().int().min(0).max(100),
  voltage_v: z.number(),
  current_a: z.number(),
  temperature_c: z.number(),
  charge_cycles: z.number().int().nonnegative(),
  gps: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy_m: z.number().nonnegative(),
  }),
  daily_km: z.number().nonnegative(),
  idle_hours: z.number().nonnegative(),
  bms_status: z.enum(["normal", "fault", "warning"]),
  charger_connected: z.boolean(),
});

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // ±5 minutes

function jsonError(
  status: number,
  body: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(body, { status });
}

function authFailed() {
  return jsonError(401, { error: "DEVICE_AUTH_FAILED" });
}

function base64UrlDecode(s: string): Buffer {
  const pad = 4 - (s.length % 4);
  const norm = (s + "===".slice(0, pad % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  return Buffer.from(norm, "base64");
}

/**
 * Verify an HS256 device JWT.
 * Token form: base64url(header).base64url(payload).base64url(signature)
 *   header  = { alg: "HS256", typ: "JWT" }
 *   payload = { iss: <imeiId>, ... }
 * Signing key: IOT_DEVICE_TOKEN_SECRET.
 *
 * Returns true on a valid signature whose iss matches the X-Device-IMEI header.
 */
function verifyDeviceToken(token: string, imeiId: string): boolean {
  const secret = process.env.IOT_DEVICE_TOKEN_SECRET;
  if (!secret) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [h, p, s] = parts;
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(base64UrlDecode(h).toString("utf8"));
    payload = JSON.parse(base64UrlDecode(p).toString("utf8"));
  } catch {
    return false;
  }
  if (header.alg !== "HS256") return false;
  if (typeof payload.iss !== "string" || payload.iss !== imeiId) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${h}.${p}`)
    .digest();
  let actual: Buffer;
  try {
    actual = base64UrlDecode(s);
  } catch {
    return false;
  }
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function isTestBypass(req: NextRequest): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const secret = process.env.NBFC_TEST_BYPASS_SECRET;
  if (!secret) return false;
  return req.headers.get("x-nbfc-test-bypass") === secret;
}

export async function POST(req: NextRequest) {
  // 1. Header-level auth.
  const headerImei = req.headers.get("x-device-imei");
  const headerToken = req.headers.get("x-device-token");

  if (!headerImei) return authFailed();

  // Test bypass skips JWT verification but still requires the IMEI header.
  if (!isTestBypass(req)) {
    if (!headerToken) return authFailed();
    if (!verifyDeviceToken(headerToken, headerImei)) return authFailed();
  }

  // 2. Body parse + zod validation.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, {
      error: "INVALID_PAYLOAD",
      message: "Invalid JSON body",
    });
  }
  const parsed = IngestBody.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path?.join(".") ?? "unknown";
    return jsonError(422, {
      error: "INVALID_PAYLOAD",
      field,
      message: issue?.message ?? "Validation failed",
    });
  }
  const data = parsed.data;

  // The X-Device-IMEI header MUST match the body imeiId (defence-in-depth so a
  // device can't authenticate as itself but report someone else's serial).
  if (data.imeiId !== headerImei) {
    return authFailed();
  }

  // 3. Stale-packet guard (±5 min).
  const deviceTs = Date.parse(data.timestamp);
  const serverNow = Date.now();
  if (Number.isNaN(deviceTs)) {
    return jsonError(422, {
      error: "INVALID_PAYLOAD",
      field: "timestamp",
      message: "Unparseable timestamp",
    });
  }
  if (Math.abs(serverNow - deviceTs) > STALE_THRESHOLD_MS) {
    return jsonError(422, {
      error: "INVALID_PAYLOAD",
      field: "timestamp",
      message: "Timestamp out of range (±5 minutes)",
    });
  }

  // 4. Inventory cross-check (logical FK, per BRD §6.2.3).
  // We don't enforce iot_enabled at the DB level (column not in baseline);
  // the BRD says it's a logical check, so we accept either:
  //   (a) no inventory row → reject (orphan serial)
  //   (b) inventory row whose iot_imei_no matches the IMEI header → allowed
  //   (c) iot_devices already registered for this serial → allowed
  // Order: prefer iot_devices, fall back to inventory.
  const deviceRows = await db
    .select({
      serial_number: iotDevices.serial_number,
      imei_id: iotDevices.imei_id,
    })
    .from(iotDevices)
    .where(eq(iotDevices.serial_number, data.serialNumber))
    .limit(1);

  let inventoryAllowed = false;
  if (deviceRows.length === 0) {
    const invRows = await db
      .select({
        serial_number: inventory.serial_number,
        iot_imei_no: inventory.iot_imei_no,
      })
      .from(inventory)
      .where(eq(inventory.serial_number, data.serialNumber))
      .limit(1);
    if (invRows.length === 0) {
      return jsonError(422, {
        error: "INVALID_PAYLOAD",
        field: "serialNumber",
        message: "Serial number not found in inventory",
      });
    }
    if (
      !invRows[0].iot_imei_no ||
      invRows[0].iot_imei_no !== data.imeiId
    ) {
      return jsonError(422, {
        error: "INVALID_PAYLOAD",
        field: "serialNumber",
        message: "Serial number is not IoT-enabled",
      });
    }
    inventoryAllowed = true;
  }

  // 5. INSERT telemetry_events row.
  const deviceTimeIso = new Date(deviceTs).toISOString();
  const summaryDate = deviceTimeIso.slice(0, 10); // YYYY-MM-DD in UTC

  await db.insert(telemetryEvents).values({
    serial_number: data.serialNumber,
    imei_id: data.imeiId,
    device_time: new Date(deviceTs),
    soc_percent: data.soc_percent,
    soh_percent: data.soh_percent,
    voltage_v: data.voltage_v.toString(),
    current_a: data.current_a.toString(),
    temperature_c: data.temperature_c.toString(),
    charge_cycles: data.charge_cycles,
    gps_lat: data.gps.lat.toString(),
    gps_lng: data.gps.lng.toString(),
    daily_km: data.daily_km.toString(),
    idle_hours: data.idle_hours.toString(),
    bms_status: data.bms_status,
    charger_connected: data.charger_connected,
  });

  // 6. UPDATE iot_devices cached state. If no row exists yet (legacy device
  // bootstrapped via inventory only), insert one now so downstream queries
  // (E-050/E-051) find it.
  if (deviceRows.length === 0 && inventoryAllowed) {
    // Best-effort registration. We don't know dealerId/model/category here, so
    // fill placeholders that the inventory backfill job (E-045) can refresh.
    await db
      .insert(iotDevices)
      .values({
        device_id: `IOT-${data.imeiId}`,
        serial_number: data.serialNumber,
        imei_id: data.imeiId,
        dealer_id: "UNKNOWN",
        model: "UNKNOWN",
        category: "UNKNOWN",
        device_status: "online",
        last_seen: new Date(deviceTs),
        soc_percent: data.soc_percent,
        soh_percent: data.soh_percent,
        voltage_v: data.voltage_v.toString(),
        temperature_c: data.temperature_c.toString(),
        charge_cycles: data.charge_cycles,
        gps_lat: data.gps.lat.toString(),
        gps_lng: data.gps.lng.toString(),
        gps_updated_at: new Date(),
        bms_status: data.bms_status,
      })
      .onConflictDoNothing();
  }
  await db
    .update(iotDevices)
    .set({
      last_seen: new Date(deviceTs),
      soc_percent: data.soc_percent,
      soh_percent: data.soh_percent,
      voltage_v: data.voltage_v.toString(),
      temperature_c: data.temperature_c.toString(),
      charge_cycles: data.charge_cycles,
      gps_lat: data.gps.lat.toString(),
      gps_lng: data.gps.lng.toString(),
      gps_updated_at: new Date(),
      bms_status: data.bms_status,
      device_status: "online",
      updated_at: new Date(),
    })
    .where(eq(iotDevices.serial_number, data.serialNumber));

  // 7. UPSERT telemetry_daily_summary.
  // We refresh the running aggregates from the just-inserted telemetry_events
  // rows for this (serial_number, day). This is the simplest correct
  // implementation that respects the (serial_number, summary_date) UNIQUE
  // constraint without requiring a worker job.
  const aggRows = await db.execute(dsql`
    SELECT
      AVG(soc_percent)::numeric(5,2)        AS avg_soc,
      MIN(soc_percent)::numeric(5,2)        AS min_soc,
      MAX(soh_percent)::numeric(5,2)        AS max_soh,
      MAX(daily_km)::numeric(8,2)           AS total_km,
      MAX(idle_hours)::numeric(6,2)         AS total_idle_hours,
      COUNT(*)                              AS packets_received,
      SUM(CASE WHEN bms_status IN ('fault','warning') THEN 1 ELSE 0 END) AS bms_faults
    FROM telemetry_events
    WHERE serial_number = ${data.serialNumber}
      AND device_time >= ${summaryDate}::date
      AND device_time <  (${summaryDate}::date + INTERVAL '1 day')
  `);
  const agg = (aggRows as unknown as { rows?: Record<string, unknown>[] })
    .rows?.[0] ?? (aggRows as unknown as Record<string, unknown>[])[0];
  const aggRow = (agg ?? {}) as Record<string, unknown>;

  await db
    .insert(telemetryDailySummary)
    .values({
      serial_number: data.serialNumber,
      summary_date: summaryDate,
      avg_soc: (aggRow.avg_soc as string | null) ?? null,
      min_soc: (aggRow.min_soc as string | null) ?? null,
      max_soh: (aggRow.max_soh as string | null) ?? null,
      total_km: (aggRow.total_km as string | null) ?? null,
      total_idle_hours: (aggRow.total_idle_hours as string | null) ?? null,
      bms_faults: Number(aggRow.bms_faults ?? 0),
      packets_received: Number(aggRow.packets_received ?? 1),
      gps_home_lat: data.gps.lat.toString(),
      gps_home_lng: data.gps.lng.toString(),
    })
    .onConflictDoUpdate({
      target: [
        telemetryDailySummary.serial_number,
        telemetryDailySummary.summary_date,
      ],
      set: {
        avg_soc: (aggRow.avg_soc as string | null) ?? null,
        min_soc: (aggRow.min_soc as string | null) ?? null,
        max_soh: (aggRow.max_soh as string | null) ?? null,
        total_km: (aggRow.total_km as string | null) ?? null,
        total_idle_hours: (aggRow.total_idle_hours as string | null) ?? null,
        bms_faults: Number(aggRow.bms_faults ?? 0),
        packets_received: Number(aggRow.packets_received ?? 1),
      },
    });

  // 8. Alert-rule evaluation (E-049) is a downstream unit, not in scope here.

  return NextResponse.json({
    accepted: true,
    serverTime: new Date(serverNow).toISOString(),
  });
}
