/**
 * E-216 — the "Scan now" endpoint for the purchase side.
 *
 *   POST                 start a scan; replies as soon as the run row exists
 *   GET  ?run_id=<uuid>  that run's current state, for the caller polling it
 *
 * WHY THIS NO LONGER RUNS THE SCAN INSIDE THE REQUEST
 *   It used to, and returned the finished summary. The sales twin was rewritten
 *   away from that pattern first, for a reason that applies here identically:
 *   for the whole of a multi-minute scan the browser holds an open connection,
 *   and anything that interrupts the app in that window answers it with nginx's
 *   own HTML page instead of JSON. What the user sees is
 *   `Unexpected token '<', "<html> <h"... is not valid JSON`, with no hint that
 *   invoices were in fact imported before the process went away.
 *
 *   Now the request lasts about as long as one INSERT, the scan continues in
 *   the process (a long-lived pm2 node server, not a serverless function — the
 *   6-hourly ticker in instrumentation-node.ts already works this way), and the
 *   caller polls GET for the outcome.
 *
 *   It is also what makes `drain` safe to ask for: draining a backlog can take
 *   far longer than any request should live.
 *
 * Concurrency is handled inside runDriveScan via the DB `running` row, so this
 * route, the ticker and the cron route cannot double-import the same file.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireApiAdmin } from "@/lib/auth/requireApiAdmin";
import { isNextRedirectError, errorMessage } from "@/lib/api-utils";
import {
  getDriveRun,
  runDriveScan,
  type DriveScanSummary,
} from "@/lib/expenses/driveScan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BodySchema = z.object({
  /** drive_expense_folders.id — omit to scan every active folder. */
  folder_id: z.string().uuid().optional(),
  /**
   * Keep going until the folder is finished, rather than stopping at the
   * per-run cap. What the button sends: one press should mean one job.
   */
  drain: z.boolean().optional(),
  /**
   * Retry files that are still resting under the cooldown. Sent by the
   * "Retry these" action on the needs-attention queue, where a person has
   * explicitly asked for another attempt.
   */
  retry_now: z.boolean().optional(),
});

/** What POST answers with when the scan is under way rather than finished. */
interface StartedResponse {
  status: "started";
  run_id: string;
}

export async function POST(req: NextRequest) {
  try {
    const guard = await requireApiAdmin();
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
    const outcome = await new Promise<StartedResponse | DriveScanSummary>((resolve) => {
      let answered = false;
      const answer = (value: StartedResponse | DriveScanSummary) => {
        if (answered) return;
        answered = true;
        resolve(value);
      };

      runDriveScan({
        folderId: parsed.data.folder_id,
        triggeredBy: guard.user.id,
        drain: parsed.data.drain ?? true,
        ignoreCooldown: parsed.data.retry_now ?? false,
        onStart: (runId) => answer({ status: "started", run_id: runId }),
      }).then(
        (summary) => answer(summary),
        // runDriveScan records its own failures and returns them, so this only
        // catches the ones raised before it has a run row to write them to.
        // Attached rather than left dangling: after the response has gone out
        // an unhandled rejection here would take the whole process down.
        (err) => {
          const msg = errorMessage(err);
          console.error("[drive/scan] run failed:", msg);
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
    console.error("[drive/scan] error:", msg);
    return NextResponse.json({ success: false, error: { message: msg } }, { status: 500 });
  }
}

/**
 * The other half of the POST above: where a caller finds out how the scan it
 * started is going. Shaped like a DriveScanSummary so one banner renders a
 * polled result and a straight-back one alike, with `running` added for "not
 * finished yet".
 */
export async function GET(req: NextRequest) {
  try {
    const guard = await requireApiAdmin();
    if (!guard.ok) return guard.response;

    const runId = req.nextUrl.searchParams.get("run_id");
    if (!runId) {
      return NextResponse.json(
        { success: false, error: { message: "run_id is required" } },
        { status: 400 },
      );
    }

    const run = await getDriveRun(runId);
    if (!run) {
      return NextResponse.json(
        { success: false, error: { message: "No such scan run." } },
        { status: 404 },
      );
    }

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
    console.error("[drive/scan] status error:", msg);
    return NextResponse.json({ success: false, error: { message: msg } }, { status: 500 });
  }
}
