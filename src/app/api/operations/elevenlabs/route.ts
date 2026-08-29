/**
 * GET /api/operations/elevenlabs — the same read model the page renders.
 *
 * See /api/operations/infrastructure for why the page calls getElevenLabsView()
 * directly rather than fetching this.
 *
 * ?range= takes the same values as the page (mtd | 3m | 6m | all | YYYY-MM) and
 * goes through the SAME parseRange/resolveRange, which is why those two live in
 * the lib module rather than in the page: it is not possible for the page and
 * this route to disagree about what a range means. The resolved window is
 * echoed back so a consumer never has to re-derive what "6m" meant today.
 *
 * THE PAYLOAD IS SPLIT INTO `live` AND `historical`, and that split is the
 * point. `GET ?range=2026-02` used to return the credit balance as of right now
 * inside a body that was otherwise entirely February — the page compensated
 * with layout and copy, but a machine consumer had only the TypeScript doc
 * comments to warn it. `live` is the vendor account as it stands and ignores
 * the window by definition; everything under `historical` is scoped to it.
 *
 * `data` is retained alongside, unchanged, so existing consumers keep working.
 */

import { NextResponse } from "next/server";

import { getElevenLabsView } from "@/lib/operations/elevenlabs";
import { parseRange, resolveRange } from "@/lib/operations/elevenlabsSeries";
import { requireOperationsAdmin } from "@/lib/operations/route-guard";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireOperationsAdmin();
  if (!auth.ok) return auth.response;

  const params = Object.fromEntries(new URL(req.url).searchParams);
  const filters = resolveRange(parseRange(params));

  try {
    const view = await getElevenLabsView(filters);

    return NextResponse.json({
      success: true,
      filters,
      live: {
        /** As of `credits.age_minutes` ago — NOT of the selected window. */
        credits: view.credits,
        credits_series: view.credits_series,
        collector: view.collector,
        last_updated: view.last_updated,
      },
      historical: {
        window: filters,
        /** Credits consumed inside the window, from the vendor's own history. */
        credit_usage: view.credit_usage,
        /** Our own ledger: calls, cost in INR paise, talk time in seconds. */
        totals: view.range,
        previous: view.prev,
        all_time: view.total,
        trend: view.trend,
        by_category: view.by_category,
        recent: view.recent,
        /**
         * Six complete calendar months. Deliberately NOT the window — this is
         * the navigation context the bars link into, and momDelta is only
         * defined on adjacent complete months.
         */
        monthly: view.monthly,
        mom_delta_pct: view.mom_delta_pct,
      },
      // Retained verbatim for existing consumers.
      data: view,
    });
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        error: {
          message:
            e instanceof Error ? e.message : "Failed to read ElevenLabs usage",
          hint: "If this says a relation does not exist, apply drizzle/E-210_ops_monitoring.sql to this database.",
        },
      },
      { status: 500 },
    );
  }
}
