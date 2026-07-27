/**
 * E-214 — POST /api/admin/ai-expenses/drive/scan
 *
 * The "Scan now" button. Runs a Drive scan synchronously and returns the
 * summary, so the admin sees what happened rather than a fire-and-forget
 * "started".
 *
 * `maxDuration = 300` and a 100-file cap keep one invocation inside the
 * function timeout: each new file costs a download plus one GPT-4o call. A
 * folder with more than that left to do finishes across subsequent runs — the
 * ticker picks up exactly where this left off, because "already done" is a
 * property of the file (its md5 in drive_expense_files), not of the run.
 *
 * Concurrency is handled inside runDriveScan via the DB `running` row, so this
 * route and the 6-hourly ticker cannot double-import the same file.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireApiAdmin } from "@/lib/auth/requireApiAdmin";
import { isNextRedirectError, errorMessage } from "@/lib/api-utils";
import { runDriveScan } from "@/lib/expenses/driveScan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MANUAL_MAX_FILES = 100;

/**
 * Stop with 60s to spare on the 300s maxDuration below.
 *
 * The file cap alone was not enough: a file costs ~15s, so 100 of them run for
 * ~25 minutes and the handler was killed long before finishing — leaving its
 * run row stranded at 'running', which then blocked the next scan for half an
 * hour. Returning early is free, because the next press resumes from the same
 * place: "already processed" is a property of the file's md5, not of the run.
 */
const MANUAL_TIME_BUDGET_MS = 240_000;

const BodySchema = z.object({
  /** drive_expense_folders.id — omit to scan every active folder. */
  folder_id: z.string().uuid().optional(),
});

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

    const summary = await runDriveScan({
      folderId: parsed.data.folder_id,
      triggeredBy: guard.user.id,
      maxFiles: MANUAL_MAX_FILES,
      timeBudgetMs: MANUAL_TIME_BUDGET_MS,
    });

    // A scan that refused to start (another already running, nothing
    // configured) is not an error — it is a result the UI should show plainly.
    return NextResponse.json({ success: true, data: summary });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    const msg = errorMessage(e);
    console.error("[drive/scan] error:", msg);
    return NextResponse.json({ success: false, error: { message: msg } }, { status: 500 });
  }
}
