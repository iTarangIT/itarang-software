/**
 * E-234 — POST|GET /api/cron/auction/tick
 *
 * Drives one auction scheduler tick from outside the process. The in-process
 * ticker in `src/instrumentation-node.ts` is the mechanism that actually runs
 * in sandbox and production (see the long note there on why not BullMQ); this
 * route exists so the same work can be triggered by hand, by a Vercel cron on a
 * deployment that has one, or by a health check that wants to prove the closer
 * still works.
 *
 * Both handlers exist because Vercel cron sends GET. Auth follows the canonical
 * pattern from /api/cron/nbfc/compute-cds.
 */
import { NextRequest, NextResponse } from "next/server";
import { runAuctionTick } from "@/lib/nbfc/auction/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorised(req: NextRequest): boolean {
  if (req.headers.get("x-vercel-cron")) return true;
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (expected && auth === `Bearer ${expected}`) return true;
  if (
    process.env.NBFC_TEST_BYPASS === "1" &&
    process.env.NBFC_TEST_BYPASS_SECRET &&
    req.headers.get("x-nbfc-test-bypass") === process.env.NBFC_TEST_BYPASS_SECRET
  ) {
    return true;
  }
  if (process.env.NODE_ENV !== "production") return true;
  return false;
}

async function handle(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }
  try {
    const result = await runAuctionTick();
    return NextResponse.json({
      ok: true,
      opened: result.opened.length,
      closed: result.closed.length,
      ending_soon: result.ending_soon.length,
      // [E-234] Announcements drained this tick. Summed rather than listed so
      // the health-check answer stays one line; `detail` has the per-lot rows.
      announced: result.fanned_out.reduce((s, f) => s + f.dealers, 0),
      notify_failed: result.fanned_out.reduce((s, f) => s + f.failed, 0),
      detail: result,
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
