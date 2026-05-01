/**
 * E-082 — Hourly cron sweep that expires stale pending_approval rows.
 *
 * Vercel cron pings this endpoint via GET (or POST, depending on cron config).
 * We accept either. Auth is via the Vercel cron header
 * `x-vercel-cron-signature` (validated when CRON_SECRET is set), or the
 * triple-guarded test bypass for E2E tests.
 */
import { NextRequest, NextResponse } from "next/server";
import { isTestBypassRequest } from "@/lib/nbfc/dual-approval/auth";
import { expireStaleDualApprovalRequests } from "@/lib/nbfc/dual-approval/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorize(req: NextRequest): boolean {
  if (isTestBypassRequest(req.headers)) return true;
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    // No secret configured → only allow in non-prod and only via test bypass.
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
  const expired = await expireStaleDualApprovalRequests(new Date());
  return NextResponse.json({
    ok: true,
    expired_count: expired.length,
    expired_ids: expired.map((r) => r.id),
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
