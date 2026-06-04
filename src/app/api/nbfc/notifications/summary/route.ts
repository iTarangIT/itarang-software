/**
 * GET /api/nbfc/notifications/summary — live work-queue counts for the current
 * NBFC tenant. Polled by the portal sidebar (Acquire badge) and header bell.
 * Tenant resolved the same way as the portal layout (getCurrentTenant), so the
 * counts always match the workspace the user is looking at.
 */
import { NextResponse } from "next/server";

import { getCurrentTenant } from "@/lib/nbfc/tenant";
import { getNbfcWorkQueueCounts } from "@/lib/nbfc/work-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const tenant = await getCurrentTenant();
    const counts = await getNbfcWorkQueueCounts(tenant.id, Date.now());
    return NextResponse.json({ ok: true, ...counts });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
