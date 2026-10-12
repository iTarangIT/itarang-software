/**
 * E-091 — DPDPA retention nightly cron.
 *
 * Vercel cron pings GET; we accept POST too. Auth is via the Vercel cron
 * Bearer token (`CRON_SECRET`) or the triple-guarded test bypass for E2E.
 *
 * The canonical "actor" path (admin user invoking via UI) lives at
 * /api/nbfc/dpdpa/retention/run; this endpoint is the unattended scheduler.
 */
import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron-auth";
import { isTestBypassRequest } from "@/lib/nbfc/dual-approval/auth";
import { runDpdpaRetention } from "@/lib/nbfc/dpdpa/retentionCron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: NextRequest) {
  if (!(isTestBypassRequest(req.headers) || isCronAuthorised(req))) {
    return NextResponse.json(
      { ok: false, error: "UNAUTHORIZED: cron auth missing" },
      { status: 401 },
    );
  }
  const result = await runDpdpaRetention({});
  return NextResponse.json({ ok: true, ...result });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
