/**
 * GET /api/admin/nbfc/ecosystem-overview  (E-065 — BRD §6.3.2)
 *
 * Admin-only ecosystem overview for iTarang Ops. Returns 7 metric tiles plus
 * a per-NBFC comparison array. NBFC-tenant JWTs MUST receive 403 — this is
 * the platform-wide view, not a tenant-scoped one.
 *
 * Auth: shares the canonical NBFC admin idiom (resolveAdminActor) so the
 * triple-guarded test bypass works identically to the rest of the admin
 * surface (E-001, E-005).
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveAdminActor, statusFromError } from "@/lib/nbfc/admin/auth";
import { computeEcosystemOverview } from "@/lib/nbfc/ecosystem-overview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await resolveAdminActor(req.headers);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }

  try {
    const overview = await computeEcosystemOverview();
    return NextResponse.json(overview);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
