/**
 * GET /api/nbfc/iot/fleet
 *
 * Returns the current tenant's IoT fleet summary (KPI strip data). Useful for
 * client-side polling or for embedding the strip in another surface.
 *
 * Auth gating mirrors /api/nbfc/risk/run — see that file's doc-block.
 */
import { NextResponse } from "next/server";
import { getCurrentTenant, getTenantLoanSlice, requireNbfcAccess } from "@/lib/nbfc/tenant";
import { getFleetSummary } from "@/lib/db/iot-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const tenant = await getCurrentTenant();
    await requireNbfcAccess(tenant.id);
    const loans = await getTenantLoanSlice(tenant.id);
    const vnos = loans
      .map((l) => l.vehicleno)
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    const summary = await getFleetSummary(vnos);
    return NextResponse.json({ tenant: tenant.slug, summary });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.startsWith("UNAUTHORIZED") ? 401 : msg.startsWith("FORBIDDEN") ? 403 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
