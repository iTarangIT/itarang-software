/**
 * POST /api/nbfc/acquire/[leadId]/kyc/ocr
 *
 * NBFC-side mirror of the admin KYC OCR autofill route. The NBFC re-runs OCR on
 * a captured KYC document (PAN / Aadhaar / bank / cheque / RC) to autofill the
 * shared review cards, reusing the exact admin OCR pipeline via `runKycOcr`.
 * Only the auth differs: this route uses the NBFC dual-approval actor + active
 * assignment gate instead of the admin's Supabase session.
 *
 * Body: { doc_type: string, doc_for?: string }
 * Response: { success, ocr_data, source, decentro_error?, error? } — same as admin.
 * Role: credit_underwriting | nbfc_admin, scoped to the acting tenant.
 */
import { NextRequest, NextResponse } from "next/server";

import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { runKycOcr } from "@/lib/kyc/ocr-extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  const { leadId } = await params;

  const actor = await resolveActor(req.headers);
  if (actor.role !== "credit_underwriting" && actor.role !== "nbfc_admin") {
    return NextResponse.json(
      { success: false, error: `FORBIDDEN: role '${actor.role}' cannot run OCR` },
      { status: 403 },
    );
  }
  const assignment = await getActiveAssignment(leadId, actor.tenant_id);
  if (!assignment) {
    return NextResponse.json(
      { success: false, error: "BAD_REQUEST: no assignment for this lead under this tenant" },
      { status: 400 },
    );
  }

  const body = await req.json();
  const doc_type: string = typeof body.doc_type === "string" ? body.doc_type : "";
  const doc_for: string = typeof body.doc_for === "string" ? body.doc_for : "customer";

  const { status, ...result } = await runKycOcr(leadId, { docType: doc_type, docFor: doc_for });
  return NextResponse.json(result, { status: status ?? 200 });
}
