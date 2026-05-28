/**
 * GET /api/nbfc/portfolio/command-centre  (BRD §6.1.3)
 *
 * One endpoint backing the redesigned Portfolio Command Centre: KPI block with
 * honest deltas, unified alert feed, regional risk, weekly stats, recent
 * actions. A single call keeps `computed_at` coherent and lets the sub-blocks
 * share the resolved active-loan set.
 *
 * Auth mirrors portfolio/summary (getCurrentTenant + requireNbfcAccess); the
 * x-nbfc-test-bypass branch mirrors portfolio/freshness so the loop's
 * Playwright tests can target it. Tenant isolation: every query inside
 * computeCommandCentre filters by tenant id.
 */
import { NextResponse } from "next/server";
import { computeCommandCentre } from "@/lib/nbfc/command-centre";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";
import { isTestBypassRequest, resolveActor } from "@/lib/nbfc/dual-approval/auth";

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
    const data = await computeCommandCentre(tenantId);
    return NextResponse.json(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.startsWith("UNAUTHORIZED")
      ? 401
      : msg.startsWith("FORBIDDEN")
        ? 403
        : 500;
    if (status === 500) {
      // Never surface raw exception text to the client — log it server-side
      // and return a generic message.
      console.error("[nbfc/portfolio/command-centre] unhandled error:", e);
      return NextResponse.json(
        { ok: false, error: "Internal server error" },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
