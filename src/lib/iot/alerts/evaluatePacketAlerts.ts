/**
 * E-049 — Per-packet telemetry alert evaluator (BRD §6.2.6).
 *
 * Called from the telemetry-ingestion path (E-046 step 6) after a
 * telemetry_events row has been inserted and iot_devices has been
 * updated. Evaluates the six "per-packet" rules from BRD 6.2.6:
 *
 *   - BMS Fault         (bms_status === 'fault')                    → critical
 *   - High Temperature  (temperature_c > 55)                         → critical
 *   - Low SOC           (soc_percent < 10 AND charger_connected=false) → info
 *   - Usage Drop        (today daily_km < 0.6 * 7-day avg)            → warning
 *   - Geo-Shift         (haversine(current, gps_home) > 100km)        → critical
 *   - SOH Decline       (soh_percent today vs 30 days ago drop > 5pp) → warning
 *
 * The two "absence-of-packet" rules (Battery Offline, Battery Offline
 * Extended) are evaluated by `scanOfflineBatteriesCron.ts` since they
 * fire on the absence of a packet, not on its arrival.
 *
 * Dedup contract: at most one OPEN telemetry_alerts row per
 * (serial_number, rule) — enforced by the partial unique index on
 * telemetry_alerts. Re-firing the same rule for the same serial while an
 * open alert exists is a no-op.
 *
 * Notification fan-out (`notified_to`) is recorded inline as a JSON
 * audit trail. Actual delivery (NBFC dashboard rows are persisted
 * implicitly by the alert row; email / admin / dealer fan-out is
 * queued by downstream consumers reading telemetry_alerts).
 */
import { db } from "@/lib/db";
import { telemetryAlerts, telemetryDailySummary } from "@/lib/db/schema";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";

export type PacketInput = {
  serial_number: string;
  bms_status?: string | null;
  temperature_c?: number | string | null;
  soc_percent?: number | null;
  soh_percent?: number | null;
  charger_connected?: boolean | null;
  daily_km?: number | string | null;
  gps_lat?: number | string | null;
  gps_lng?: number | string | null;
  device_time?: Date | string | null;
};

export type RuleName =
  | "BMS Fault"
  | "High Temperature"
  | "Low SOC"
  | "Usage Drop"
  | "Geo-Shift"
  | "SOH Decline";

const SEVERITY: Record<RuleName, "critical" | "warning" | "info"> = {
  "BMS Fault": "critical",
  "High Temperature": "critical",
  "Low SOC": "info",
  "Usage Drop": "warning",
  "Geo-Shift": "critical",
  "SOH Decline": "warning",
};

const NOTIFY_AUDIENCE: Record<RuleName, string[]> = {
  "BMS Fault": ["nbfc-dashboard", "dealer-dashboard", "after-sales-flag"],
  "High Temperature": ["nbfc-dashboard", "dealer-dashboard", "safety-flag"],
  "Low SOC": ["dealer-dashboard"],
  "Usage Drop": ["nbfc-dashboard"],
  "Geo-Shift": ["nbfc-dashboard", "admin-alert"],
  "SOH Decline": ["nbfc-dashboard", "warranty-claim-check"],
};

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Great-circle distance between two lat/lng pairs in km. */
function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371; // km
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Insert one telemetry_alerts row, deduplicated by the (serial_number, rule)
 * partial unique index WHERE resolved_at IS NULL. Returns the inserted row's
 * id, or null if a row already existed (ON CONFLICT DO NOTHING).
 */
export async function raiseAlert(opts: {
  serial_number: string;
  rule: RuleName | "Battery Offline" | "Battery Offline Extended";
  severity: "critical" | "warning" | "info";
  payload?: Record<string, unknown>;
  cds_flagged?: boolean;
  notified_to?: string[];
}): Promise<{ id: number | null; created: boolean }> {
  const audience =
    opts.notified_to ??
    (opts.rule in NOTIFY_AUDIENCE
      ? NOTIFY_AUDIENCE[opts.rule as RuleName]
      : ["nbfc-dashboard"]);

  // ON CONFLICT on the partial unique index (serial_number, rule) WHERE
  // resolved_at IS NULL → silently skip if an open alert already exists.
  const inserted = await db
    .insert(telemetryAlerts)
    .values({
      serial_number: opts.serial_number,
      rule: opts.rule,
      severity: opts.severity,
      payload: opts.payload ?? null,
      notified_to: audience.map((a) => ({
        audience: a,
        at: new Date().toISOString(),
      })),
      cds_flagged: opts.cds_flagged ?? false,
    })
    .onConflictDoNothing({
      target: [telemetryAlerts.serial_number, telemetryAlerts.rule],
      where: sql`${telemetryAlerts.resolved_at} IS NULL`,
    })
    .returning({ id: telemetryAlerts.id });

  if (inserted.length === 0) return { id: null, created: false };
  return { id: inserted[0].id, created: true };
}

/**
 * Per-packet evaluator. Returns the list of rules raised for this packet.
 * Idempotent — re-evaluating the same packet does not produce duplicate
 * open alerts.
 */
export async function evaluatePacketAlerts(
  packet: PacketInput,
): Promise<{ raised: RuleName[]; deduped: RuleName[] }> {
  const raised: RuleName[] = [];
  const deduped: RuleName[] = [];

  async function maybe(rule: RuleName, payload: Record<string, unknown>) {
    const r = await raiseAlert({
      serial_number: packet.serial_number,
      rule,
      severity: SEVERITY[rule],
      payload,
    });
    if (r.created) raised.push(rule);
    else deduped.push(rule);
  }

  // Rule 1: BMS Fault.
  if (packet.bms_status === "fault") {
    await maybe("BMS Fault", { bms_status: packet.bms_status });
  }

  // Rule 2: High Temperature (>55C).
  const temp = num(packet.temperature_c);
  if (temp !== null && temp > 55) {
    await maybe("High Temperature", { temperature_c: temp, threshold: 55 });
  }

  // Rule 3: Low SOC (<10 AND charger not connected).
  const soc = num(packet.soc_percent);
  if (
    soc !== null &&
    soc < 10 &&
    packet.charger_connected === false
  ) {
    await maybe("Low SOC", {
      soc_percent: soc,
      charger_connected: false,
      threshold: 10,
    });
  }

  // Rule 4: Usage Drop (today daily_km < 0.6 * 7-day avg total_km).
  const todayKm = num(packet.daily_km);
  if (todayKm !== null && todayKm >= 0) {
    try {
      const today = new Date(packet.device_time ?? new Date());
      const sevenAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
      const isoToday = today.toISOString().slice(0, 10);
      const isoSeven = sevenAgo.toISOString().slice(0, 10);
      const summaries = await db
        .select({ total_km: telemetryDailySummary.total_km })
        .from(telemetryDailySummary)
        .where(
          and(
            eq(telemetryDailySummary.serial_number, packet.serial_number),
            gte(telemetryDailySummary.summary_date, isoSeven),
            lte(telemetryDailySummary.summary_date, isoToday),
          ),
        );
      if (summaries.length >= 3) {
        const vals = summaries
          .map((s) => num(s.total_km))
          .filter((v): v is number => v !== null);
        if (vals.length >= 3) {
          const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
          if (avg > 0 && todayKm < 0.6 * avg) {
            await maybe("Usage Drop", {
              today_km: todayKm,
              seven_day_avg: avg,
              drop_threshold_pct: 40,
            });
          }
        }
      }
    } catch {
      // Best-effort — never block ingestion on a side-channel rule.
    }
  }

  // Rule 5: Geo-Shift (>100km from gps_home_*).
  const lat = num(packet.gps_lat);
  const lng = num(packet.gps_lng);
  if (lat !== null && lng !== null) {
    try {
      const recent = await db
        .select({
          gps_home_lat: telemetryDailySummary.gps_home_lat,
          gps_home_lng: telemetryDailySummary.gps_home_lng,
        })
        .from(telemetryDailySummary)
        .where(eq(telemetryDailySummary.serial_number, packet.serial_number))
        .orderBy(desc(telemetryDailySummary.summary_date))
        .limit(7);
      const homes = recent
        .map((r) => ({
          lat: num(r.gps_home_lat),
          lng: num(r.gps_home_lng),
        }))
        .filter((h): h is { lat: number; lng: number } =>
          h.lat !== null && h.lng !== null,
        );
      if (homes.length > 0) {
        // Most-frequent cluster ≈ rounded to 0.1 degree. Pick mode.
        const counts = new Map<string, { count: number; lat: number; lng: number }>();
        for (const h of homes) {
          const key = `${h.lat.toFixed(1)}|${h.lng.toFixed(1)}`;
          const cur = counts.get(key);
          if (cur) cur.count += 1;
          else counts.set(key, { count: 1, lat: h.lat, lng: h.lng });
        }
        const mode = [...counts.values()].sort((a, b) => b.count - a.count)[0];
        const dist = haversineKm(lat, lng, mode.lat, mode.lng);
        if (dist > 100) {
          await maybe("Geo-Shift", {
            current: { lat, lng },
            home: { lat: mode.lat, lng: mode.lng },
            distance_km: Math.round(dist * 10) / 10,
            threshold_km: 100,
          });
        }
      }
    } catch {
      // Best-effort.
    }
  }

  // Rule 6: SOH Decline (>5pp drop in 30 days).
  const sohNow = num(packet.soh_percent);
  if (sohNow !== null) {
    try {
      const today = new Date(packet.device_time ?? new Date());
      const thirtyAgoLow = new Date(today.getTime() - 32 * 24 * 60 * 60 * 1000);
      const thirtyAgoHigh = new Date(today.getTime() - 28 * 24 * 60 * 60 * 1000);
      const baseline = await db
        .select({ max_soh: telemetryDailySummary.max_soh })
        .from(telemetryDailySummary)
        .where(
          and(
            eq(telemetryDailySummary.serial_number, packet.serial_number),
            gte(
              telemetryDailySummary.summary_date,
              thirtyAgoLow.toISOString().slice(0, 10),
            ),
            lte(
              telemetryDailySummary.summary_date,
              thirtyAgoHigh.toISOString().slice(0, 10),
            ),
          ),
        )
        .limit(1);
      const before = baseline.length ? num(baseline[0].max_soh) : null;
      if (before !== null && before - sohNow > 5) {
        await maybe("SOH Decline", {
          soh_30d_ago: before,
          soh_today: sohNow,
          drop_pp: Math.round((before - sohNow) * 10) / 10,
          threshold_pp: 5,
        });
      }
    } catch {
      // Best-effort.
    }
  }

  return { raised, deduped };
}
