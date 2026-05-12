/**
 * GET /api/nbfc/portfolio/summary  (E-026 — BRD §6.1.3)
 *
 * Thin wrapper: resolve tenant, gate access, delegate compute.
 * RBI Digital Lending Directions 2025: a tenant must NEVER see another
 * tenant's aggregates — every query inside computePortfolioSummary filters by
 * tenant.id, and requireNbfcAccess() throws on a cross-tenant request.
 */
import { NextResponse } from "next/server";
import { computePortfolioSummary } from "@/lib/nbfc/portfolio-summary";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const tenant = await getCurrentTenant();
    await requireNbfcAccess(tenant.id);
    const summary = await computePortfolioSummary(tenant.id);
    return NextResponse.json(summary);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.startsWith("UNAUTHORIZED")
      ? 401
      : msg.startsWith("FORBIDDEN")
        ? 403
        : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
