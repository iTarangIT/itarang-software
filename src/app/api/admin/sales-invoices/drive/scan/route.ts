/**
 * E-280 — POST /api/admin/sales-invoices/drive/scan
 *
 * The "Scan sales now" button. Runs a Drive sales scan synchronously and
 * returns the summary, so the admin sees what happened rather than a
 * fire-and-forget "started".
 *
 * `maxDuration = 300` and a 100-file cap keep one invocation inside the
 * function timeout: each new file costs a download plus one vision call. A
 * folder with more than that left to do finishes across subsequent runs — the
 * ticker picks up exactly where this left off, because "already done" is a
 * property of the file (its checksum in sales_scan_files), not of the run.
 *
 * Concurrency is handled inside runSalesScan via the DB `running` row, so this
 * route and the 6-hourly ticker cannot double-import the same file. The guard
 * is scoped to sales runs, so a sales scan and an expense scan can overlap —
 * they read disjoint folders and write different tables.
 *
 * The initial backfill of ~135 historical invoices is NOT meant to go through
 * here; use scripts/backfill-drive-sales.ts, which runs outside the HTTP
 * timeout and rehearses before it writes.
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
import { runSalesScan } from "@/lib/sales/driveSalesScan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ALLOWED_ROLES = new Set(["admin", "sales_head", "ceo"]);

const MANUAL_MAX_FILES = 100;

/**
 * Stop with 60s to spare on the 300s maxDuration above. Returning early is
 * free: the next press resumes from the same place.
 */
const MANUAL_TIME_BUDGET_MS = 240_000;

const BodySchema = z.object({
  /** sales_invoice_folders.id — omit to scan every active folder. */
  folder_id: z.string().uuid().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const user = await requireAuth();
    if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) {
      return NextResponse.json(
        { success: false, error: { message: "FORBIDDEN" } },
        { status: 403 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: { message: "Validation failed" } },
        { status: 400 },
      );
    }

    const summary = await runSalesScan({
      folderId: parsed.data.folder_id,
      triggeredBy: user.id,
      maxFiles: MANUAL_MAX_FILES,
      timeBudgetMs: MANUAL_TIME_BUDGET_MS,
    });

    // A scan that refused to start (another already running, nothing
    // configured) is not an error — it is a result the UI should show plainly.
    return NextResponse.json({ success: true, data: summary });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    const msg = errorMessage(e);
    console.error("[sales-invoices/drive/scan] error:", msg);
    return NextResponse.json({ success: false, error: { message: msg } }, { status: 500 });
  }
}
