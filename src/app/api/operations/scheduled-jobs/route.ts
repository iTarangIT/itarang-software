/**
 * GET /api/operations/scheduled-jobs — ID 227: every scheduled job, what runs
 * it on this server, and when it last ran. The Ops Console > Jobs page reads
 * the same function directly; this route is for curl during an incident.
 */

import { NextResponse } from "next/server";

import { requireOperationsAdmin } from "@/lib/operations/route-guard";
import { getScheduledJobsReport } from "@/lib/operations/scheduledJobsStatus";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireOperationsAdmin();
  if (!auth.ok) return auth.response;

  try {
    const data = await getScheduledJobsReport();
    return NextResponse.json({ success: true, data });
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        error: { message: e instanceof Error ? e.message : "Failed to read scheduled jobs" },
      },
      { status: 500 },
    );
  }
}
