/**
 * E-049 — Offline-scan cron route (BRD §6.2.6, AC4 + AC5).
 *
 * Vercel cron entry-point. Scans iot_devices for last_seen > 24h / 48h and
 * raises Battery Offline / Battery Offline Extended telemetry_alerts rows.
 *
 * Auth model mirrors `/api/cron/nbfc-cor-expiry`:
 *   - x-vercel-cron header → trust
 *   - Bearer CRON_SECRET   → trust
 *   - Nothing else, in any environment (ID 130)
 */
import { NextRequest, NextResponse } from "next/server";
import { scanOfflineBatteries } from "@/lib/iot/alerts/scanOfflineBatteriesCron";
import { isCronAuthorised } from "@/lib/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function runJob(req: NextRequest) {
  if (!isCronAuthorised(req)) {
    return NextResponse.json(
      { ok: false, error: "UNAUTHORIZED" },
      { status: 401 },
    );
  }
  try {
    // Allow tests to pin "now" with ?now=ISO so AC4/AC5 can deterministically
    // simulate a 25h or 49h offset without time-travelling the system clock.
    const url = new URL(req.url);
    const nowParam = url.searchParams.get("now");
    const now = nowParam ? new Date(nowParam) : new Date();
    if (Number.isNaN(now.getTime())) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid `now` parameter" },
        { status: 400 },
      );
    }
    const result = await scanOfflineBatteries({ now });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.error("[cron/iot/scan-offline-batteries] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return runJob(req);
}

export async function POST(req: NextRequest) {
  return runJob(req);
}
