/**
 * E-105 — POST /api/admin/zoho/sync
 *
 * CEO-only, on-demand trigger for the Zoho Invoice full-pull. The hourly
 * refresh runs via /api/cron/zoho-sync (Bearer CRON_SECRET), but that secret
 * can't ship to the browser — so the CEO "Refresh from Zoho" button calls this
 * session-authenticated endpoint instead, reusing the same isCeo() gate as the
 * invoices list and the same syncInvoicesSinceLastRun() worker as the cron.
 *
 * Mirrors the auth model and response shape of GET /api/admin/zoho/invoices.
 */
import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-utils";
import { isCeo } from "@/lib/zoho/access";
import { syncInvoicesSinceLastRun } from "@/lib/zoho/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const user = await requireAuth();
    if (!isCeo(user)) {
      return NextResponse.json(
        { success: false, error: { message: "FORBIDDEN: CEO only" } },
        { status: 403 },
      );
    }

    const result = await syncInvoicesSinceLastRun();
    return NextResponse.json({ success: true, ...result });
  } catch (e: any) {
    // requireAuth() redirects unauthenticated callers via Next's special
    // NEXT_REDIRECT throw — surface it so the framework handles the redirect
    // instead of returning a misleading 500. syncInvoicesSinceLastRun already
    // records real failures to zoho_sync_state.last_error.
    if (e?.digest?.startsWith?.("NEXT_REDIRECT")) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { success: false, error: { message: msg } },
      { status: 500 },
    );
  }
}
