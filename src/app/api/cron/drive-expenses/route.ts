/**
 * E-216 — Scheduled Google Drive expense scan.
 *
 * The primary driver for this job is the in-process ticker in
 * instrumentation-node.ts, because Vercel crons do not fire on the Hostinger
 * PM2 boxes (docs/DEPLOY_RUNBOOK.md). This route exists as the second path:
 * the VPS root crontab curls it, and it lets anyone trigger a scan without
 * the admin UI.
 *
 * Both paths call the same runDriveScan, whose DB-level `running` guard means
 * a crontab hit and a ticker tick landing together cannot double-import.
 *
 * Auth model copied verbatim from /api/cron/zoho-sync.
 */
import { NextRequest, NextResponse } from "next/server";
import { runDriveScan } from "@/lib/expenses/driveScan";
import { isCronAuthorised } from "@/lib/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function runJob(req: NextRequest) {
  if (!isCronAuthorised(req)) {
    return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }

  try {
    const maxFiles = Number(process.env.DRIVE_EXPENSE_MAX_FILES_PER_RUN || "") || 25;
    const result = await runDriveScan({ triggeredBy: null, maxFiles });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[cron/drive-expenses] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return runJob(req);
}

export async function POST(req: NextRequest) {
  return runJob(req);
}
