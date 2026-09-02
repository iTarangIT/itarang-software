/**
 * GET /api/operations/business — the same read model the page renders.
 *
 * See /api/operations/infrastructure for why the page calls its view function
 * directly rather than fetching this.
 */

import { NextResponse } from "next/server";

import { requireOperationsAdmin } from "@/lib/operations/route-guard";
import { getBusinessView } from "@/lib/operations/business";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireOperationsAdmin();
  if (!auth.ok) return auth.response;

  try {
    return NextResponse.json({ success: true, data: await getBusinessView() });
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        error: {
          message: e instanceof Error ? e.message : "Failed to read business metrics",
          hint: "If this says a relation does not exist, apply drizzle/E-210_ops_monitoring.sql to this database.",
        },
      },
      { status: 500 },
    );
  }
}
