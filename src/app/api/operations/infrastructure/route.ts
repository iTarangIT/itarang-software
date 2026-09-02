/**
 * GET /api/operations/infrastructure — the same read model the page renders.
 *
 * Shares getInfrastructureView() with the page so the two cannot drift. The
 * page does not fetch this (a server component calling its own HTTP API goes
 * out through nginx and back, so an nginx fault would stop the monitoring page
 * from explaining the fault) — this is for curl during an incident and for
 * whatever wants the numbers without the HTML.
 */

import { NextResponse } from "next/server";

import { requireOperationsAdmin } from "@/lib/operations/route-guard";
import { getInfrastructureView } from "@/lib/operations/views";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireOperationsAdmin();
  if (!auth.ok) return auth.response;

  try {
    return NextResponse.json({
      success: true,
      data: await getInfrastructureView(),
    });
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        error: {
          message: e instanceof Error ? e.message : "Failed to read samples",
          hint: "If this says a relation does not exist, apply drizzle/E-210_ops_monitoring.sql to this database.",
        },
      },
      { status: 500 },
    );
  }
}
