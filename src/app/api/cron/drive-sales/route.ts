/**
 * E-280 — Scheduled Google Drive sales scan.
 *
 * The primary driver for this job is the in-process ticker in
 * instrumentation-node.ts, because Vercel crons do not fire on the Hostinger
 * PM2 boxes (docs/DEPLOY_RUNBOOK.md). This route exists as the second path:
 * the VPS root crontab curls it, and it lets anyone trigger a scan without the
 * admin UI.
 *
 * Both paths call the same runSalesScan, whose DB-level `running` guard means a
 * crontab hit and a ticker tick landing together cannot double-import.
 *
 * Auth model copied verbatim from /api/cron/drive-expenses.
 */
import { NextRequest, NextResponse } from "next/server";
import { runSalesScan } from "@/lib/sales/driveSalesScan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorised(req: NextRequest): boolean {
  if (req.headers.get("x-vercel-cron")) return true;

  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (expected && auth === `Bearer ${expected}`) return true;

  if (process.env.NODE_ENV !== "production") return true;

  return false;
}

async function runJob(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }

  try {
    const maxFiles = Number(process.env.DRIVE_SALES_MAX_FILES_PER_RUN || "") || 25;
    const result = await runSalesScan({ triggeredBy: null, maxFiles });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[cron/drive-sales] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return runJob(req);
}

export async function POST(req: NextRequest) {
  return runJob(req);
}
