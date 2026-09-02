/**
 * E-280 — GET /api/admin/sales-invoices/drive/runs
 *
 * Scan history for the admin panel.
 *
 *   ?run_id=<uuid>     per-file outcomes for one run
 *   ?view=attention    files still needing a human, across all runs
 *   ?view=invoices     imported invoices carrying a flag
 *   (default)          the last 20 runs
 *
 * The last of those is a different list from `view=attention`: a file can
 * import cleanly as a row that is itself questionable (a date that disagrees
 * with its folder, a possible duplicate). Conflating the two would tell an
 * admin that an invoice sitting in the revenue total is missing from it.
 */
import { NextRequest, NextResponse } from "next/server";

import { requireApiAdmin } from "@/lib/auth/requireApiAdmin";
import { isNextRedirectError, errorMessage } from "@/lib/api-utils";
import {
  listRecentSalesRuns,
  listSalesAttentionFiles,
  listSalesAttentionInvoices,
  listSalesRunFiles,
} from "@/lib/sales/driveSalesScan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const guard = await requireApiAdmin();
    if (!guard.ok) return guard.response;

    const sp = req.nextUrl.searchParams;
    const runId = sp.get("run_id");
    const view = sp.get("view");

    // Response shapes match the expense twin (/api/admin/ai-expenses/drive/runs)
    // so a panel written against one works against the other.
    if (runId) {
      return NextResponse.json({
        success: true,
        data: { files: await listSalesRunFiles(runId) },
      });
    }
    if (view === "attention") {
      return NextResponse.json({
        success: true,
        data: { files: await listSalesAttentionFiles(100) },
      });
    }
    if (view === "invoices") {
      return NextResponse.json({
        success: true,
        data: { invoices: await listSalesAttentionInvoices(100) },
      });
    }
    return NextResponse.json({
      success: true,
      data: { runs: await listRecentSalesRuns() },
    });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    const msg = errorMessage(e);
    console.error("[sales-invoices/drive/runs] error:", msg);
    return NextResponse.json({ success: false, error: { message: msg } }, { status: 500 });
  }
}
