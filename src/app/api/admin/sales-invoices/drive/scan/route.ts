/**
 * E-280 — the "Scan sales now" endpoint.
 *
 *   POST                 start a scan; replies as soon as the run row exists
 *   GET  ?run_id=<uuid>  that run's current state, for the caller polling it
 *
 * WHY THIS DOES NOT RUN THE SCAN INSIDE THE REQUEST
 *   It used to, and returned the finished summary. A real scan takes minutes
 *   (~4s per new file: one download plus one vision call), and for the whole of
 *   that time the browser was holding an open connection to the app. Anything
 *   that interrupts the app in that window answers the browser with nginx's own
 *   HTML error page instead of JSON — and on sandbox that is routine, because
 *   every push to main redeploys and restarts pm2 under whatever is in flight.
 *   What the CEO saw was `Unexpected token '<', "<html> <h"... is not valid
 *   JSON`, with no hint that 2 invoices had in fact been imported before the
 *   process went away.
 *
 *   So the request now lasts about as long as one INSERT. The scan continues in
 *   the process (a long-lived pm2 node server, not a serverless function — the
 *   6-hourly ticker in instrumentation-node.ts already works this way), and the
 *   caller polls GET for the outcome. A restart mid-scan is still a lost scan,
 *   but it is now a lost scan that says so, instead of a nonsensical parse
 *   error in front of a number the CEO is trying to trust.
 *
 * The initial backfill of ~135 historical invoices is NOT meant to go through
 * here; use scripts/backfill-drive-sales.ts, which runs outside the request
 * lifecycle entirely and rehearses before it writes.
 *
 * Concurrency is handled inside runSalesScan via the DB `running` row, so this
 * route and the 6-hourly ticker cannot double-import the same file. The guard
 * is scoped to sales runs, so a sales scan and an expense scan can overlap —
 * they read disjoint folders and write different tables.
 *
 * WHY THIS ONE IS NOT requireApiAdmin
 *   Its expense-side twin is admin-only, and the path prefix here says /admin
 *   for symmetry with it. But this action is "pull in the invoices my revenue
 *   figure is missing", and that button belongs on /ceo/invoices — where the
 *   CEO, not an admin, is the person looking at a stale number. So the role set
 *   is widened by exactly one role rather than forcing a CEO to ask an admin to
 *   press refresh. Configuring WHICH folders are scanned stays admin-only, in
 *   the folders route next door.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/auth-utils";
import { isNextRedirectError, errorMessage } from "@/lib/api-utils";
import {
  getSalesRun,
  runSalesScan,
  type SalesScanSummary,
} from "@/lib/sales/driveSalesScan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ALLOWED_ROLES = new Set(["admin", "sales_head", "ceo"]);

const MANUAL_MAX_FILES = 100;

/**
 * How long the background scan works before stopping cleanly. Nothing waits on
 * it any more, so this is not a request timeout — it is how much of a large
 * folder one press gets through. Stopping early costs nothing: "already
 * processed" is a property of the file's checksum, so the next press resumes
 * exactly where this one ended.
 */
const MANUAL_TIME_BUDGET_MS = 240_000;

const BodySchema = z.object({
  /** sales_invoice_folders.id — omit to scan every active folder. */
  folder_id: z.string().uuid().optional(),
});

async function requireScanRole() {
  const user = await requireAuth();
  if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { success: false, error: { message: "FORBIDDEN" } },
        { status: 403 },
      ),
    };
  }
  return { ok: true as const, user };
}

/** What POST answers with when the scan is under way rather than finished. */
interface StartedResponse {
  status: "started";
  run_id: string;
}

export async function POST(req: NextRequest) {
  try {
    const guard = await requireScanRole();
    if (!guard.ok) return guard.response;

    const body = await req.json().catch(() => ({}));
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: { message: "Validation failed" } },
        { status: 400 },
      );
    }

    // Answer on whichever comes first: the run row being created (the normal
    // case — reply and let the scan carry on), or the whole scan settling
    // without one. A scan that refused to start (nothing configured, another
    // already running) is not an error; it comes back as the same summary it
    // always did, so the UI keeps saying plainly why nothing happened.
    const outcome = await new Promise<StartedResponse | SalesScanSummary>((resolve) => {
      let answered = false;
      const answer = (value: StartedResponse | SalesScanSummary) => {
        if (answered) return;
        answered = true;
        resolve(value);
      };

      runSalesScan({
        folderId: parsed.data.folder_id,
        triggeredBy: guard.user.id,
        maxFiles: MANUAL_MAX_FILES,
        timeBudgetMs: MANUAL_TIME_BUDGET_MS,
        onStart: (runId) => answer({ status: "started", run_id: runId }),
      }).then(
        (summary) => answer(summary),
        // runSalesScan records its own failures and returns them, so this only
        // catches the ones raised before it has a run row to write them to.
        // Attached rather than left dangling: after the response has gone out
        // an unhandled rejection here would take the whole process down.
        (err) => {
          const msg = errorMessage(err);
          console.error("[sales-invoices/drive/scan] run failed:", msg);
          answer({
            run_id: null,
            status: "failed",
            folders_scanned: 0,
            files_seen: 0,
            files_new: 0,
            imported: 0,
            skipped_duplicate: 0,
            needs_attention: 0,
            unsupported: 0,
            failed: 0,
            duration_ms: 0,
            error: msg,
          });
        },
      );
    });

    return NextResponse.json({ success: true, data: outcome });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    const msg = errorMessage(e);
    console.error("[sales-invoices/drive/scan] error:", msg);
    return NextResponse.json({ success: false, error: { message: msg } }, { status: 500 });
  }
}

/**
 * The other half of the POST above: where a caller finds out how the scan it
 * started ended. Same role set — whoever may press the button may read the
 * result of pressing it.
 */
export async function GET(req: NextRequest) {
  try {
    const guard = await requireScanRole();
    if (!guard.ok) return guard.response;

    const runId = req.nextUrl.searchParams.get("run_id");
    if (!runId) {
      return NextResponse.json(
        { success: false, error: { message: "run_id is required" } },
        { status: 400 },
      );
    }

    const run = await getSalesRun(runId);
    if (!run) {
      return NextResponse.json(
        { success: false, error: { message: "No such scan run." } },
        { status: 404 },
      );
    }

    // Shaped like a SalesScanSummary so one banner renders a polled result and
    // a straight-back one alike, with `running` added for "not finished yet".
    return NextResponse.json({
      success: true,
      data: {
        run_id: run.id,
        status: run.status,
        folders_scanned: run.folder_id ? 1 : 0,
        files_seen: run.files_seen,
        files_new: run.files_new,
        imported: run.imported,
        skipped_duplicate: run.skipped_duplicate,
        needs_attention: run.needs_attention,
        unsupported: run.unsupported,
        failed: run.failed,
        duration_ms: run.duration_ms ?? Date.now() - new Date(run.started_at).getTime(),
        error: run.error_message ?? undefined,
      },
    });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    const msg = errorMessage(e);
    console.error("[sales-invoices/drive/scan] status error:", msg);
    return NextResponse.json({ success: false, error: { message: msg } }, { status: 500 });
  }
}
