/**
 * POST /api/admin/nbfc-requests/rejections/[assignmentId]/forward
 *
 * E-275 — admin forwards an NBFC's file rejection (with its reason) to the
 * dealer. No body. Auth: requireAdminAppUser().
 */
import { NextRequest, NextResponse } from "next/server";

import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { forwardRejectionToDealer } from "@/lib/nbfc/rejection-forward";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ assignmentId: string }> },
) {
  try {
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json({ success: false, error: { message: "Unauthorized" } }, { status: 403 });
    }
    const { assignmentId } = await params;
    const result = await forwardRejectionToDealer({
      assignmentId,
      source: "admin",
      adminUserId: appUser.id,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to forward rejection";
    return NextResponse.json(
      { success: false, error: { message: message.replace(/^(BAD_REQUEST|NOT_FOUND):\s*/, "") } },
      { status: statusFromError(message) },
    );
  }
}
