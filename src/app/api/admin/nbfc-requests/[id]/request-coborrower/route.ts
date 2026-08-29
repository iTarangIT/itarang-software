/**
 * POST /api/admin/nbfc-requests/[id]/request-coborrower
 *
 * Admin one-click action on an NBFC-initiated 'co_borrower' request. Triggers the
 * standard dealer co-borrower KYC flow (same as the admin's Request Co-Borrower
 * KYC modal) using the NBFC's reason, then pushes the wrapper back to the NBFC so
 * it can track the outcome (the co-borrower appears under the NBFC's Co-Borrower
 * tab once the dealer completes KYC).
 *
 * The work itself lives in `actionNbfcCoBorrowerRequest` (E-254) so the SLA
 * sweep runs exactly what this button does.
 *
 * Auth: requireAdminAppUser().
 */
import { NextRequest, NextResponse } from "next/server";

import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { actionNbfcCoBorrowerRequest } from "@/lib/nbfc/doc-request-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(
  _req: NextRequest,
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

    const data = await actionNbfcCoBorrowerRequest({
      requestId: id,
      adminUserId: appUser.id,
      source: "admin",
    });

    return NextResponse.json({ success: true, data });
  } catch (error) {
    const raw =
      error instanceof Error ? error.message : "Failed to request co-borrower";
    const message = raw.replace(/^(NOT_FOUND|BAD_REQUEST):\s*/, "");
    return NextResponse.json(
      { success: false, error: { message } },
      { status: statusFromError(raw) },
    );
  }
}
