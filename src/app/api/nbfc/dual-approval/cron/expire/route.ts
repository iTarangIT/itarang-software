/**
 * E-082 — Hourly cron sweep that expires stale pending_approval rows.
 *
 * Vercel cron pings this endpoint via GET (or POST, depending on cron config).
 * We accept either. Auth is `Bearer CRON_SECRET` (closed when unset — ID 130),
 * or the triple-guarded test bypass for E2E tests.
 */
import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron-auth";
import { isTestBypassRequest } from "@/lib/nbfc/dual-approval/auth";
import { expireStaleDualApprovalRequests } from "@/lib/nbfc/dual-approval/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: NextRequest) {
  if (!(isTestBypassRequest(req.headers) || isCronAuthorised(req))) {
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
