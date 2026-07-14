/**
 * POST /api/nbfc/risk/run
 *
 * Triggers the risk-hypothesis workflow for the current tenant and returns the
 * run summary. The Risk page reads the resulting cards from risk_card_runs.
 *
 * Auth:
 *   - nbfc_partner: must be a member of the tenant they're running against
 *   - admin / ceo:  always allowed
 *   - dev (no session): allowed only when NBFC_DEMO_TENANT_SLUG is set and
 *                        NODE_ENV != production
 *
 * Concurrency: E-187 takes a per-tenant lock. A second request while one is in
 * flight gets 409 rather than starting a duplicate workflow — double-clicking
 * the button used to run the whole thing twice.
 *
 * Still synchronous: this blocks for ~30-60s. The nightly cron
 * (/api/cron/nbfc/risk-analysis) is what keeps cards fresh; this endpoint exists
 * for an operator who wants an answer now.
 */
import { NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { getCurrentTenant, getSessionUser, requireNbfcAccess } from "@/lib/nbfc/tenant";
import { runRiskWorkflow } from "@/lib/ai/langgraph/risk-hypothesis-graph";
import { RunInFlightError } from "@/lib/nbfc/risk-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST() {
  try {
    const tenant = await getCurrentTenant();
    await requireNbfcAccess(tenant.id);
    const user = await getSessionUser();

    const summary = await runRiskWorkflow(tenant, {
      trigger: "manual",
      actorUserId: user?.id ?? null,
    });
    return NextResponse.json({ ok: true, tenant: tenant.slug, ...summary });
  } catch (e) {
    if (e instanceof RunInFlightError) {
      return NextResponse.json(
        {
          ok: false,
          error: "A risk analysis is already running for this tenant. Wait for it to finish.",
          started_at: e.startedAt.toISOString(),
        },
        { status: 409 },
      );
    }
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.startsWith("UNAUTHORIZED") ? 401 : msg.startsWith("FORBIDDEN") ? 403 : 500;
    return NextResponse.json({ ok: false, error: clientError(e) }, { status });
  }
}
