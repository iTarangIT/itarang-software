/**
 * POST /api/admin/zoho/sync
 *
 * CEO-only. On-demand trigger for the Zoho Invoice sync — the same full-pull
 * the hourly cron (/api/cron/zoho-sync) and the in-process ticker run, but
 * fired by the CEO from the Sales Invoices page "Refresh from Zoho" button so
 * they don't have to wait up to an hour for the next scheduled run.
 *
 * Mirrors the auth model of GET /api/admin/zoho/invoices.
 */
import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-utils";
import { syncInvoicesSinceLastRun } from "@/lib/zoho/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isCeo(user: { role?: string; email?: string }): boolean {
  const role = (user.role || "").toLowerCase();
  const email = (user.email || "").toLowerCase();
  return role === "ceo" || email === "sanchit@itarang.com";
}

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
