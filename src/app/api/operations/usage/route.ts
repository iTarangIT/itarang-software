/**
 * GET /api/operations/usage — the same read model the page renders.
 *
 * See /api/operations/infrastructure for why the page calls getUsageView()
 * directly rather than fetching this.
 *
 * Guarded by requireUsageAnalyticsAdmin(), NOT requireOperationsAdmin(): this
 * endpoint returns per-person sign-in history, and the two role sets exist
 * precisely so that widening console access does not silently widen access to
 * this. See src/lib/operations/route-guard.ts.
 *
 * Filters go through the SAME parseUsageFilters the page uses, so the two can
 * never disagree about what `?days=30&user=…` means.
 */

import { NextResponse } from "next/server";

import { requireUsageAnalyticsAdmin } from "@/lib/operations/route-guard";
import { getUsageView } from "@/lib/operations/usage";
import { parseUsageFilters } from "@/lib/operations/usageMath";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireUsageAnalyticsAdmin();
  if (!auth.ok) return auth.response;

  const params = Object.fromEntries(new URL(req.url).searchParams);
  const filters = parseUsageFilters(params);

  try {
    return NextResponse.json({
      success: true,
      filters,
      data: await getUsageView(filters),
    });
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        error: {
          message: e instanceof Error ? e.message : "Failed to read CRM usage",
          hint: "If this says a relation does not exist, apply drizzle/E-214_usage_analytics.sql to this database.",
        },
      },
      { status: 500 },
    );
  }
}
