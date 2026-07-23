/**
 * POST /api/nbfc/acquire/[leadId]/kyc/verification/[verificationId]/action
 *
 * NBFC mirror of the admin accept/reject-with-verification-id. The rich KYC
 * cards call this when an objective verification row exists. It looks up the
 * shared kyc_verifications row by id to resolve verification_type + applicant,
 * then records the NBFC's OWN verdict in nbfc_document_verifications (Change 1) —
 * never touching the shared admin_action. Body: { action, notes, rejection_reason }.
 *
 * Role: credit_underwriting | nbfc_admin, scoped to the acting tenant's assignment.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { kycVerifications } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { upsertNbfcVerdict, verdictFromAction } from "@/lib/nbfc/doc-verdict";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string; verificationId: string }> },
) {
  try {
    const { leadId, verificationId } = await params;

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

    const [row] = await db
      .select({
        verification_type: kycVerifications.verification_type,
        applicant: kycVerifications.applicant,
      })
      .from(kycVerifications)
      .where(
        and(
          eq(kycVerifications.id, verificationId),
          eq(kycVerifications.lead_id, leadId),
        ),
      )
      .limit(1);

    if (!row) {
      return NextResponse.json(
        { success: false, error: { message: "Verification not found for this lead" } },
        { status: 404 },
      );
    }

    const docFor = row.applicant === "co_borrower" ? "co_borrower" : "primary";
    const notes = body.notes || body.rejection_reason || null;

    await upsertNbfcVerdict({
      leadId,
      assignmentId: assignment.id,
      nbfcId: assignment.nbfc_id,
      tenantId: actor.tenant_id,
      docFor,
      docKey: row.verification_type,
      verdict,
      notes,
      verifiedBy: actor.user_id,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[NBFC Verification Action] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to record verdict";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
