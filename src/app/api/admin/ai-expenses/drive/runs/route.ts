/**
 * E-214 — GET /api/admin/ai-expenses/drive/runs
 *
 * Scan history for the admin panel.
 *
 *   (no params)      → the last 20 runs
 *   ?run_id=<uuid>   → that run's per-file outcomes
 *   ?view=attention  → every file still needing a human, across all runs
 *
 * The run log is what makes a quiet scanner debuggable: without it, "no new
 * expenses" and "the ticker has not run since the last deploy" look identical.
 * That exact ambiguity hid a dead nightly job for five days (see
 * docs/DEPLOY_RUNBOOK.md).
 */
import { NextRequest, NextResponse } from "next/server";

import { requireApiAdmin } from "@/lib/auth/requireApiAdmin";
import { isNextRedirectError, errorMessage } from "@/lib/api-utils";
import {
  listAttentionFiles,
  listRecentRuns,
  listRunFiles,
} from "@/lib/expenses/driveScan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const guard = await requireApiAdmin();
    if (!guard.ok) return guard.response;

    const sp = req.nextUrl.searchParams;
    const runId = sp.get("run_id");
    const view = sp.get("view");

    if (runId) {
      return NextResponse.json({
        success: true,
        data: { files: await listRunFiles(runId) },
      });
    }

    if (view === "attention") {
      return NextResponse.json({
        success: true,
        data: { files: await listAttentionFiles(100) },
      });
    }

    return NextResponse.json({
      success: true,
      data: { runs: await listRecentRuns(20) },
    });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    return NextResponse.json(
      { success: false, error: { message: errorMessage(e) } },
      { status: 500 },
    );
  }
}
