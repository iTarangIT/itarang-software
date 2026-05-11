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
import { isTestBypassRequest } from "@/lib/nbfc/dual-approval/auth";
import { runDpdpaRetention } from "@/lib/nbfc/dpdpa/retentionCron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorize(req: NextRequest): boolean {
  if (isTestBypassRequest(req.headers)) return true;
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return process.env.NODE_ENV !== "production";
  }
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${cronSecret}`;
}

async function handle(req: NextRequest) {
  if (!authorize(req)) {
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
