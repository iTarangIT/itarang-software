/**
 * POST /api/nbfc/acquire/[leadId]/kyc/verification/manual
 *
 * NBFC mirror of the admin manual accept/reject. The rich KYC cards call this
 * when no objective verification row exists yet. Instead of writing the shared
 * admin_action, it records the NBFC's OWN verdict in nbfc_document_verifications
 * (Change 1). Body: { action, verification_type, applicant, notes, rejection_reason }.
 *
 * Role: credit_underwriting | nbfc_admin, scoped to the acting tenant's assignment.
 */
import { NextRequest, NextResponse } from "next/server";

import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { upsertNbfcVerdict, verdictFromAction } from "@/lib/nbfc/doc-verdict";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const { leadId } = await params;

    const actor = await resolveActor(req.headers);
    if (actor.role !== "credit_underwriting" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { success: false, error: { message: `Role '${actor.role}' cannot verify documents` } },
        { status: 403 },
      );
    }
    const assignment = await getActiveAssignment(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json(
        { success: false, error: { message: "No assignment for this lead under this tenant" } },
        { status: 400 },
      );
    }

    const body = await req.json();
    const verdict = verdictFromAction(String(body.action));
    if (!verdict) {
      return NextResponse.json(
        { success: false, error: { message: `Unknown action '${body.action}'` } },
        { status: 400 },
      );
    }
    const docKey = String(body.verification_type || "").trim();
    if (!docKey) {
      return NextResponse.json(
        { success: false, error: { message: "verification_type is required" } },
        { status: 400 },
      );
    }
    const docFor = body.applicant === "co_borrower" ? "co_borrower" : "primary";
    const notes = body.notes || body.rejection_reason || null;

    await upsertNbfcVerdict({
      leadId,
      assignmentId: assignment.id,
      nbfcId: assignment.nbfc_id,
      tenantId: actor.tenant_id,
      docFor,
      docKey,
      verdict,
      notes,
      verifiedBy: actor.user_id,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[NBFC Manual Verdict] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to record verdict";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
