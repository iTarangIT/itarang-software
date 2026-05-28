/**
 * E-001 — GET /api/admin/nbfc/{nbfcId}/approval-readiness
 *
 * Powers the admin review page (NbfcFinalApprovalPanel). Returns the booleans
 * the UI needs to disable/enable the Approve button + render the tooltip.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";
import { evaluateApprovalReadiness } from "@/lib/nbfc/admin/approval-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ nbfcId: string }> },
) {
  const auth = await requireAdminOrTestBypass(req.headers);
  if (!auth.ok) return auth.response;

  const { nbfcId } = await ctx.params;
  const id = Number.parseInt(nbfcId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json(
      { canApprove: false, missingDocs: [], lspAgreementStatus: "MISSING", reason: "Invalid nbfcId" },
      { status: 400 },
    );
  }

  const r = await evaluateApprovalReadiness(id);
  if (!r.exists) {
    return NextResponse.json(
      {
        canApprove: false,
        missingDocs: [],
        lspAgreementStatus: "MISSING",
        missingEntityKyc: ["cin", "pan", "gstin"],
        missingDirectorKyc: ["pan", "aadhaar", "rc"],
        reason: "NBFC not found",
        currentStatus: null,
      },
      { status: 404 },
    );
  }

  return NextResponse.json({
    canApprove: r.canApprove,
    missingDocs: r.missingDocs,
    lspAgreementStatus: r.lspAgreementStatus,
    missingEntityKyc: r.missingEntityKyc,
    missingDirectorKyc: r.missingDirectorKyc,
    reason: r.reason,
    currentStatus: r.currentStatus ?? null,
    pendingCorrections: r.pendingCorrections,
  });
}
