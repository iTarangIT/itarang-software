/**
 * GET /api/nbfc/notifications/summary — live work-queue counts for the current
 * NBFC tenant. Polled by the portal sidebar (Acquire badge) and header bell.
 * Tenant resolved the same way as the portal layout (getCurrentTenant), so the
 * counts always match the workspace the user is looking at.
 */
import { NextResponse } from "next/server";

import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";
import { getNbfcWorkQueueCounts } from "@/lib/nbfc/work-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const tenant = await getCurrentTenant();
    // ID 118: getCurrentTenant falls back to a default tenant when nobody is
    // signed in, so on its own it answered an anonymous caller with a real
    // tenant's work-queue counts. requireNbfcAccess is the login + membership
    // check every other /api/nbfc route makes.
    await requireNbfcAccess(tenant.id);
    const counts = await getNbfcWorkQueueCounts(tenant.id, Date.now());
    return NextResponse.json({ ok: true, ...counts });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = message.startsWith("UNAUTHORIZED") ? 401 : message.startsWith("FORBIDDEN") ? 403 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
