/**
 * GET /api/operations/logs — the explorer's read model as JSON.
 *
 * Accepts the same query parameters as the page (host, service, level, q,
 * hours, fingerprint) through the same parseFilters(), so a URL that works in
 * the browser works in curl with /api prefixed.
 */

import { NextResponse, type NextRequest } from "next/server";

import { getLogsView, parseFilters } from "@/lib/operations/logs";
import { requireOperationsAdmin } from "@/lib/operations/route-guard";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireOperationsAdmin();
  if (!auth.ok) return auth.response;

  const filters = parseFilters(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );

  try {
    return NextResponse.json({ success: true, data: await getLogsView(filters) });
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        error: {
          message: e instanceof Error ? e.message : "Failed to read log events",
          hint: "If this says a relation does not exist, apply drizzle/E-210_ops_monitoring.sql to this database.",
        },
      },
      { status: 500 },
    );
  }
}
