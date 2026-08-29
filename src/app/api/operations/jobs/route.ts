/**
 * GET /api/operations/jobs — collector health.
 *
 * One row per REGISTERED collector joined to its latest run, including
 * collectors that have never run. The page itself is a server component and
 * calls getCollectorHealth() directly rather than fetching this; the route
 * exists for the things that cannot, namely the "Run now" button's refresh and
 * anyone checking the console from a terminal during an incident.
 */

import { NextResponse } from "next/server";

import { requireOperationsAdmin } from "@/lib/operations/route-guard";
import { getCollectorHealth, getMonitorFreshness } from "@/lib/operations/runner";

// Reads live run rows — a cached answer to "is the monitoring alive?" is worse
// than no answer.
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireOperationsAdmin();
  if (!auth.ok) return auth.response;

  try {
    const [collectors, freshness] = await Promise.all([
      getCollectorHealth(),
      getMonitorFreshness(),
    ]);

    return NextResponse.json({
      success: true,
      data: { collectors, freshness },
    });
  } catch (e) {
    // Almost always "relation ops_collector_runs does not exist" — E-210 not
    // applied on this environment. Say so plainly; the generic 500 sends people
    // hunting through the runner instead of the migration checklist.
    return NextResponse.json(
      {
        success: false,
        error: {
          message: e instanceof Error ? e.message : "Failed to read collector runs",
          hint: "If this says a relation does not exist, apply drizzle/E-210_ops_monitoring.sql to this database.",
        },
      },
      { status: 500 },
    );
  }
}
