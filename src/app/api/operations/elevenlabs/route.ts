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
    return NextResponse.json({
      success: true,
      filters,
      data: await getElevenLabsView(filters),
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
