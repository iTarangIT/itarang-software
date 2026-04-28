/**
 * POST /api/nbfc/risk/run
 *
 * Triggers the risk-hypothesis LangGraph workflow for the current tenant.
 * Returns the run summary (cards generated, token usage). The Risk page reads
 * the latest cards from risk_card_runs after this completes.
 *
 * Auth (Phase C):
 *   - nbfc_partner: must be a member of the tenant they're running against
 *   - admin / ceo:  always allowed
 *   - dev (no session): allowed only when NBFC_DEMO_TENANT_SLUG is set and
 *                        NODE_ENV != production
 *
 * Phase A: synchronous — blocks the request for ~30-60s. Phase D moves this
 * onto the BullMQ worker so the UI can poll for status.
 */
import { NextResponse } from "next/server";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";
import { runRiskWorkflow } from "@/lib/ai/langgraph/risk-hypothesis-graph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST() {
  try {
    const tenant = await getCurrentTenant();
    await requireNbfcAccess(tenant.id);
    const summary = await runRiskWorkflow(tenant);
    return NextResponse.json({ ok: true, tenant: tenant.slug, ...summary });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.startsWith("UNAUTHORIZED") ? 401 : msg.startsWith("FORBIDDEN") ? 403 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
