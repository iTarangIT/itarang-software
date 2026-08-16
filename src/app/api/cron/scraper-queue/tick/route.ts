/**
 * E-241 — POST|GET /api/cron/scraper-queue/tick
 *
 * Drives one scraper batch-queue tick from outside the process: reconcile any
 * finished jobs, then dispatch at most one queued job whose schedule window is
 * open.
 *
 * The in-process ticker in `src/instrumentation-node.ts`
 * (startScraperQueueTicker) is what actually drains the queue in sandbox and
 * production — Vercel crons do not fire on the pm2 boxes. This route exists for
 * the same three reasons /api/cron/auction/tick does: to trigger the work by
 * hand while debugging a stuck batch, to give a Vercel deployment a cron entry
 * to point at, and to let a health check prove the dispatcher still works
 * without waiting 30 seconds to find out.
 *
 * Calling it while the in-process ticker is also running is safe and is not a
 * race: dispatchOnce() bails when any run is already 'running', and its claim
 * is a single `FOR UPDATE SKIP LOCKED` statement, so the worst case is that one
 * of the two callers finds nothing to do.
 *
 * Both handlers exist because Vercel cron sends GET. Auth follows the canonical
 * pattern from /api/cron/auction/tick.
 */
import { NextRequest, NextResponse } from "next/server";
import { runQueueTick } from "@/lib/scraper/jobQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorised(req: NextRequest): boolean {
  if (req.headers.get("x-vercel-cron")) return true;
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (expected && auth === `Bearer ${expected}`) return true;
  if (process.env.NODE_ENV !== "production") return true;
  return false;
}

async function handle(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json(
      { ok: false, error: "UNAUTHORIZED" },
      { status: 401 },
    );
  }
  try {
    const result = await runQueueTick();
    return NextResponse.json({
      ok: true,
      reconciled: result.reconciled,
      // null is the normal answer: either nothing is queued, or a run is
      // already in flight, or every queued job is outside its window.
      dispatched: result.dispatched,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  return handle(req);
}

export async function GET(req: NextRequest) {
  return handle(req);
}
