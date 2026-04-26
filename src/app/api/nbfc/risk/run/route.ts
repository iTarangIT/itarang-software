/**
 * POST /api/nbfc/risk/run
 *
 * Triggers the risk-hypothesis LangGraph workflow for the current tenant.
 * Returns the run summary (cards generated, token usage). The Risk page reads
 * the latest cards from risk_card_runs after this completes.
 *
 * Phase A: synchronous — blocks the request for ~30-60s. Phase D moves this
 * onto the BullMQ worker so the UI can poll for status.
 *
 * Phase C: gate by tenant ownership of the requesting user.
 */
import { NextResponse } from "next/server";
import { getCurrentTenant } from "@/lib/nbfc/tenant";
import { runRiskWorkflow } from "@/lib/ai/langgraph/risk-hypothesis-graph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST() {
  try {
    const tenant = await getCurrentTenant();
    const summary = await runRiskWorkflow(tenant);
    return NextResponse.json({ ok: true, tenant: tenant.slug, ...summary });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
