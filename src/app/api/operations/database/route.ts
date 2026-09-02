/**
 * GET /api/operations/database — the same read model the page renders.
 *
 * See the note on /api/operations/infrastructure for why the page reads
 * getDatabaseView() directly rather than fetching this.
 */

import { NextResponse } from "next/server";

import { requireOperationsAdmin } from "@/lib/operations/route-guard";
import { getDatabaseView } from "@/lib/operations/views";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireOperationsAdmin();
  if (!auth.ok) return auth.response;

  try {
    return NextResponse.json({ success: true, data: await getDatabaseView() });
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
