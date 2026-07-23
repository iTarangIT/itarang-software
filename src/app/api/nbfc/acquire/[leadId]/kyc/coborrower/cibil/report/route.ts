/**
 * POST /api/nbfc/acquire/[leadId]/kyc/coborrower/cibil/report
 *
 * NBFC mirror of the admin co-borrower CIBIL report route. Re-runs the
 * co-borrower's full credit-bureau report via the shared
 * @/lib/kyc/cibil-verification helper and refreshes the shared
 * kyc_verifications row (applicant='co_borrower'). Unlike the admin route it
 * does NOT stamp the coupon / first-API-execution metadata.
 *
 * Auth mirrors /api/nbfc/acquire/[leadId]/verify/run: resolveActor →
 * role gate (credit_underwriting | nbfc_admin) → active tenant assignment.
 */
import { NextRequest, NextResponse } from "next/server";

import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { executeCibilReport } from "@/lib/kyc/cibil-verification";

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
        { ok: false, error: `FORBIDDEN: role '${actor.role}' cannot run verifications` },
        { status: 403 },
      );
    }
    const assignment = await getActiveAssignment(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: no assignment for this lead under this tenant" },
        { status: 400 },
      );
    }

    const result = await executeCibilReport(leadId, { applicant: "co_borrower" });

    return NextResponse.json(
      {
        success: result.success,
        ...(result.data ? { data: result.data } : {}),
        ...(result.error ? { error: result.error } : {}),
      },
      result.status ? { status: result.status } : undefined,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
