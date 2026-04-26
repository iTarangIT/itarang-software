/**
 * GET /api/nbfc/iot/fleet
 *
 * Returns the current tenant's IoT fleet summary. Useful for client-side
 * polling or for embedding the KPI strip in another surface.
 */
import { NextResponse } from "next/server";
import { getCurrentTenant, getTenantLoanSlice } from "@/lib/nbfc/tenant";
import { getFleetSummary } from "@/lib/db/iot-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const tenant = await getCurrentTenant();
    const loans = await getTenantLoanSlice(tenant.id);
    const vnos = loans
      .map((l) => l.vehicleno)
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    const summary = await getFleetSummary(vnos);
    return NextResponse.json({ tenant: tenant.slug, summary });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
