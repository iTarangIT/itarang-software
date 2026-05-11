/**
 * GET /api/nbfc/portfolio/freshness  (E-027 — BRD §6.1.3)
 *
 * Returns the most recent CDS computed_at and telemetry ingestion timestamp
 * for the calling NBFC tenant, plus a boolean is_stale flag (true when either
 * stream is older than 24h OR missing entirely). Powers the data-freshness
 * badge on every metric card in the NBFC portal.
 *
 * Auth: tenant resolved via getCurrentTenant(); access enforced via
 * requireNbfcAccess(). In non-production environments, the request may instead
 * carry an x-nbfc-test-bypass header for the loop's Playwright tests; the
 * bypass is gated three ways (env != production, server secret set, header
 * matches secret) so it cannot be abused by a leaked header alone.
 */
import { NextResponse } from "next/server";
import { computePortfolioFreshness } from "@/lib/nbfc/portfolio-freshness";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { isTestBypassRequest } from "@/lib/nbfc/dual-approval/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    let tenantId: string;
    if (isTestBypassRequest(req.headers)) {
      const actor = await resolveActor(req.headers);
      tenantId = actor.tenant_id;
    } else {
      const tenant = await getCurrentTenant();
      await requireNbfcAccess(tenant.id);
      tenantId = tenant.id;
    }
    const result = await computePortfolioFreshness(tenantId);
    return NextResponse.json(result);
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
