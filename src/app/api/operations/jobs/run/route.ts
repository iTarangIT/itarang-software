/**
 * POST /api/operations/jobs/run — the "Run now" button.
 *
 * Runs ONE collector out of band, ignoring its intervalMs. The single-flight
 * lock still applies, so a manual run while the ticker is mid-run is answered
 * with 409 rather than producing two concurrent runs of the same collector.
 *
 * Body: { collector_id: string }
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { requireOperationsAdmin } from "@/lib/operations/route-guard";
import { findCollector, runCollector } from "@/lib/operations/runner";

export const dynamic = "force-dynamic";

// A collector can legitimately take its full timeout (20s for the jobs probe
// set), and the default serverless budget is tighter than that.
export const maxDuration = 60;

const BodySchema = z.object({
  collector_id: z.string().min(1).max(80),
});

export async function POST(request: Request) {
  const auth = await requireOperationsAdmin();
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: { message: "Body must be JSON" } },
      { status: 400 },
    );
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: { message: "collector_id is required" } },
      { status: 400 },
    );
  }

  // Only registered collectors, matched exactly. The id goes into a row that
  // the due-calculation later reads back, so an unknown id would create a run
  // history for a collector that does not exist.
  const collector = findCollector(parsed.data.collector_id);
  if (!collector) {
    return NextResponse.json(
      {
        success: false,
        error: { message: `Unknown collector: ${parsed.data.collector_id}` },
      },
      { status: 404 },
    );
  }

  // runCollector() never throws — a failed collector is a recorded outcome, not
  // an exception, which is the whole point of the runner's design. So the
  // response is 200 with status: "failed" inside, and the page shows the error
  // in the row where someone debugging will actually look for it.
  const outcome = await runCollector(collector, "manual", auth.user.id);

  return NextResponse.json(
    { success: true, data: outcome },
    // "skipped" means the lock was held — the ticker got there first. That is
    // a conflict, not a success, and the button says so rather than silently
    // reporting a run that never happened.
    { status: outcome.status === "skipped" ? 409 : 200 },
  );
}
