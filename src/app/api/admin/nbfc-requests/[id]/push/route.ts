/**
 * POST /api/admin/nbfc-requests/[id]/push
 *
 * Admin pushes a completed request up to the NBFC (Change 2, hop 7). Requires
 * every child document to be verified. Notifies the NBFC tenant.
 *
 * Auth: requireAdminAppUser().
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcDocRequests } from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { pushNbfcDocRequest } from "@/lib/nbfc/doc-requests";
import { notifyNbfcOfUpdate } from "@/lib/nbfc/doc-request-notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }
    const { id } = await params;

    const [wrapper] = await db
      .select({
        id: nbfcDocRequests.id,
        lead_id: nbfcDocRequests.lead_id,
        tenant_id: nbfcDocRequests.tenant_id,
      })
      .from(nbfcDocRequests)
      .where(eq(nbfcDocRequests.id, id))
      .limit(1);
    if (!wrapper) {
      return NextResponse.json(
        { success: false, error: { message: "NBFC request not found" } },
        { status: 404 },
      );
    }

    await pushNbfcDocRequest({ requestId: id, adminUserId: appUser.id });

    await notifyNbfcOfUpdate({
      tenantId: wrapper.tenant_id,
      leadId: wrapper.lead_id,
      requestId: id,
    }).catch(() => {});

    return NextResponse.json({ success: true, data: { status: "pushed_to_nbfc" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to push to NBFC";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: statusFromError(message) },
    );
  }
}
