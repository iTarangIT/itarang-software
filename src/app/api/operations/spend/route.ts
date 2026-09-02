/**
 * GET /api/operations/spend — the same read model the page renders.
 *
 * See /api/operations/infrastructure for why the page calls getSpendView()
 * directly rather than fetching this.
 *
 * `?window=` takes `30d` or a `YYYY-MM` month and is validated by the SAME
 * parser the page uses, so the API and the page can never resolve the same URL
 * to different windows. `?breakdown=1` adds the invoices behind a month.
 */

import { NextResponse } from "next/server";

import { requireOperationsAdmin } from "@/lib/operations/route-guard";
import { getSpendBreakdown, getSpendView } from "@/lib/operations/spend";
import { parseSpendWindow, TRAILING_30 } from "@/lib/operations/spendWindow";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireOperationsAdmin();
  if (!auth.ok) return auth.response;

  const params = Object.fromEntries(new URL(request.url).searchParams);
  const windowKey = parseSpendWindow(params);

  try {
    const data = await getSpendView(windowKey);
    // Opt-in: it is a per-invoice list, and every caller that only wants the
    // totals should not pay for it.
    const breakdown =
      params.breakdown === "1" && windowKey !== TRAILING_30
        ? await getSpendBreakdown(windowKey)
        : undefined;

    return NextResponse.json({
      success: true,
      data: breakdown ? { ...data, breakdown } : data,
    });
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        error: {
          message: e instanceof Error ? e.message : "Failed to read spend",
          hint: "If this says a relation does not exist, apply drizzle/E-210_ops_monitoring.sql to this database.",
        },
      },
      { status: 500 },
    );
  }
}
