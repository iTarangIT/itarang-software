/**
 * GET /api/nbfc/acquire/[leadId]/verify/results
 *
 * Read-back of the per-document Decentro verification results for the lead, for
 * the NBFC Acquire "NBFC KYC Verification" panel. Returns the latest
 * kyc_verifications row per (verification_type, applicant) plus the latest
 * DigiLocker/Aadhaar transaction. Scoped by an active assignment for the tenant.
 *
 * Role: any authenticated NBFC seat with an assignment (read-only).
 */
import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { digilockerTransactions, kycVerifications } from "@/lib/db/schema";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const { leadId } = await params;
    const actor = await resolveActor(req.headers);
    const assignment = await getActiveAssignment(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: no assignment for this tenant" },
        { status: 400 },
      );
    }

    const rows = await db
      .select({
        id: kycVerifications.id,
        verification_type: kycVerifications.verification_type,
        applicant: kycVerifications.applicant,
        status: kycVerifications.status,
        api_provider: kycVerifications.api_provider,
        api_response: kycVerifications.api_response,
        match_score: kycVerifications.match_score,
        failed_reason: kycVerifications.failed_reason,
        admin_action: kycVerifications.admin_action,
        completed_at: kycVerifications.completed_at,
        updated_at: kycVerifications.updated_at,
      })
      .from(kycVerifications)
      .where(eq(kycVerifications.lead_id, leadId))
      .orderBy(desc(kycVerifications.updated_at));

    // Latest per (verification_type, applicant). A null applicant is treated as
    // 'primary' (legacy rows predate the applicant column).
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const app = r.applicant ?? "primary";
      const key = `${r.verification_type}::${app}`;
      if (!latest.has(key)) latest.set(key, { ...r, applicant: app });
    }

    const digi = await db
      .select({
        id: digilockerTransactions.id,
        status: digilockerTransactions.status,
        aadhaar_extracted_data: digilockerTransactions.aadhaar_extracted_data,
        cross_match_result: digilockerTransactions.cross_match_result,
        expires_at: digilockerTransactions.expires_at,
        updated_at: digilockerTransactions.updated_at,
      })
      .from(digilockerTransactions)
      .where(eq(digilockerTransactions.lead_id, leadId))
      .orderBy(desc(digilockerTransactions.created_at))
      .limit(1);

    return NextResponse.json({
      ok: true,
      results: Array.from(latest.values()),
      digilocker: digi[0] ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
