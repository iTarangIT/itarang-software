// ID 227 — the 15-minute offline-battery scan, run in-process.
//
// The scan (scanOfflineBatteriesCron.ts) raises "Battery Offline" (>24 h) and
// "Battery Offline Extended" (>48 h, cds_flagged) alerts from iot_devices.
// last_seen. It was only in vercel.json, so it never ran on the live server.
//
// Guard: the telemetry feed moved to the AWS IoT stack. If iot_devices stopped
// being updated, every battery would look offline and be flagged, and the
// Extended flag feeds the borrower risk score (CDS). So the scan only runs when
// the feed is alive: some device was seen within FEED_ALIVE_DAYS. Otherwise the
// tick skips and says why, once per process.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

export const FEED_ALIVE_DAYS = 7;

export type OfflineScanTickResult =
  | { ran: false; reason: "no_devices" | "feed_stopped"; newestSeen: string | null }
  | { ran: true; result: Record<string, unknown> };

/** Pure: is the device feed alive enough to trust "offline"? */
export function feedAlive(newestSeen: Date | null, now: Date, days = FEED_ALIVE_DAYS): boolean {
  if (!newestSeen) return false;
  return now.getTime() - newestSeen.getTime() <= days * 24 * 60 * 60 * 1000;
}

let reportedSkip: string | null = null;

export async function runOfflineScanTick(now: Date = new Date()): Promise<OfflineScanTickResult> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS n, max(last_seen) AS newest FROM iot_devices
  `)) as unknown as Array<{ n: number; newest: string | Date | null }>;
  const n = Number(rows[0]?.n ?? 0);
  const newest = rows[0]?.newest ? new Date(rows[0].newest) : null;
  const newestSeen = newest ? newest.toISOString() : null;

  let skip: "no_devices" | "feed_stopped" | null = null;
  if (n === 0) skip = "no_devices";
  else if (!feedAlive(newest, now)) skip = "feed_stopped";
  if (skip) {
    if (reportedSkip !== skip) {
      reportedSkip = skip;
      console.log(
        `[iot-offline-scan] skipped: ${skip === "no_devices" ? "no devices in iot_devices" : `no device seen since ${newestSeen}`}`,
      );
    }
    return { ran: false, reason: skip, newestSeen };
  }
  reportedSkip = null;
  const { scanOfflineBatteries } = await import("./scanOfflineBatteriesCron");
  const result = await scanOfflineBatteries({ now });
  return { ran: true, result: result as unknown as Record<string, unknown> };
}
