/**
 * E-049 — Offline-scan cron (BRD §6.2.6, AC4 + AC5).
 *
 * Scans iot_devices for batteries whose last_seen is older than 24h or
 * 48h. Creates Battery Offline (>24h, critical) and Battery Offline
 * Extended (>48h, critical, cds_flagged=true) telemetry_alerts rows.
 *
 * Dedup: the partial unique index on (serial_number, rule) WHERE
 * resolved_at IS NULL ensures repeated scans do not stack open alerts.
 *
 * Schedule: every 15 minutes (vercel.json).
 *
 * Edge case (BRD): Battery Offline Extended supersedes Battery Offline
 * — when both apply we still only raise Extended (and leave any open
 * Battery Offline alert resolved-by-supersede so the dashboard does not
 * show duplicate red rows). We resolve the open 24h-tier alert when we
 * raise the 48h-tier one.
 */
import { db } from "@/lib/db";
import { iotDevices, telemetryAlerts } from "@/lib/db/schema";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { raiseAlert } from "./evaluatePacketAlerts";

export type ScanResult = {
  scanned_at: string;
  candidates: number;
  battery_offline_raised: number;
  battery_offline_extended_raised: number;
  superseded_24h_alerts: number;
};

export async function scanOfflineBatteries(opts?: {
  now?: Date;
}): Promise<ScanResult> {
  const now = opts?.now ?? new Date();
  const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const cutoff48h = new Date(now.getTime() - 48 * 60 * 60 * 1000);

  // Pick up devices that have a non-null last_seen older than 24h. Devices
  // that have never reported (last_seen IS NULL) are skipped — they're in
  // 'registered' state, awaiting first ping, not "offline".
  const candidates = await db
    .select({
      serial_number: iotDevices.serial_number,
      last_seen: iotDevices.last_seen,
    })
    .from(iotDevices)
    .where(lt(iotDevices.last_seen, cutoff24h));

  let raised24 = 0;
  let raised48 = 0;
  let superseded = 0;

  for (const dev of candidates) {
    const lastSeen = dev.last_seen as Date | null;
    if (!lastSeen) continue;

    if (lastSeen < cutoff48h) {
      // Battery Offline Extended (>48h) — supersedes Battery Offline.
      const r = await raiseAlert({
        serial_number: dev.serial_number,
        rule: "Battery Offline Extended",
        severity: "critical",
        cds_flagged: true,
        payload: {
          last_seen: lastSeen.toISOString(),
          hours_offline: Math.round(
            (now.getTime() - lastSeen.getTime()) / 3_600_000,
          ),
          threshold_hours: 48,
        },
        notified_to: ["nbfc-dashboard", "nbfc-email", "admin-alert"],
      });
      if (r.created) raised48 += 1;

      // Resolve any open 24h-tier alert for the same serial — the >48h
      // rule fully supersedes it.
      const closed = await db
        .update(telemetryAlerts)
        .set({ resolved_at: now })
        .where(
          and(
            eq(telemetryAlerts.serial_number, dev.serial_number),
            eq(telemetryAlerts.rule, "Battery Offline"),
            isNull(telemetryAlerts.resolved_at),
          ),
        )
        .returning({ id: telemetryAlerts.id });
      superseded += closed.length;
    } else {
      // Battery Offline (24h..48h).
      const r = await raiseAlert({
        serial_number: dev.serial_number,
        rule: "Battery Offline",
        severity: "critical",
        payload: {
          last_seen: lastSeen.toISOString(),
          hours_offline: Math.round(
            (now.getTime() - lastSeen.getTime()) / 3_600_000,
          ),
          threshold_hours: 24,
        },
        notified_to: ["nbfc-dashboard", "nbfc-email"],
      });
      if (r.created) raised24 += 1;
    }
  }

  return {
    scanned_at: now.toISOString(),
    candidates: candidates.length,
    battery_offline_raised: raised24,
    battery_offline_extended_raised: raised48,
    superseded_24h_alerts: superseded,
  };
}
// Silence unused-import warnings if lint is strict.
void sql;
