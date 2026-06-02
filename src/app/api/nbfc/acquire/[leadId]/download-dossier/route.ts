export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcLeadAssignments } from "@/lib/db/schema";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";
import { buildProfileZip } from "@/lib/lead/profile-export";

// NBFC Acquire — "Download customer dossier" (Addendum V0.2 §6 / §7).
// Streams the same ZIP bundle as the admin profile export, but scoped to the
// picked NBFC and with PII shown in FULL (the picked NBFC is the lender of
// record). Ownership gate: the current tenant must own an assignment row for
// this lead — mirrors the Acquire lead-detail page guard. No DB mutation.

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const { leadId } = await params;

    const tenant = await getCurrentTenant();
    await requireNbfcAccess(tenant.id);

    // Assignment-ownership guard — same as the lead-detail page.
    const [assignment] = await db
      .select({ id: nbfcLeadAssignments.id })
      .from(nbfcLeadAssignments)
      .where(
        and(
          eq(nbfcLeadAssignments.lead_id, leadId),
          eq(nbfcLeadAssignments.tenant_id, tenant.id),
        ),
      )
      .limit(1);
    if (!assignment) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not assigned to this NBFC" } },
        { status: 404 },
      );
    }

    const zipBuffer = await buildProfileZip(leadId, {
      generatedBy: tenant.display_name,
      maskPii: false,
    });
    if (!zipBuffer) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }

    return new NextResponse(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="customer_dossier_${leadId}.zip"`,
        "Content-Length": String(zipBuffer.byteLength),
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Failed to download dossier";
    const status = msg.startsWith("UNAUTHORIZED")
      ? 401
      : msg.startsWith("FORBIDDEN")
        ? 403
        : 500;
    if (status === 500) console.error("[Download Dossier] Error:", error);
    return NextResponse.json({ success: false, error: { message: msg } }, { status });
  }
}
