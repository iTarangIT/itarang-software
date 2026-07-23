/**
 * POST /api/nbfc/acquire/[leadId]/verify/run
 *
 * The NBFC re-runs a document's Decentro verification itself (PAN / Bank / RC /
 * CIBIL), mirroring the admin KYC review. Inputs are auto-resolved from the
 * captured KYC data; the shared kyc_verifications row is refreshed (admin's
 * accept/reject verdict is preserved). Aadhaar/DigiLocker is async and handled
 * by the separate aadhaar/initiate + aadhaar/status routes.
 *
 * Body: { doc_key: 'pan'|'bank'|'rc'|'cibil', doc_for: 'primary'|'co_borrower' }
 * Role: credit_underwriting | nbfc_admin, scoped to the acting tenant.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { runNbfcDocVerification } from "@/lib/nbfc/run-verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

const Body = z.object({
  doc_key: z.enum(["pan", "bank", "rc", "cibil"]),
  doc_for: z.enum(["primary", "co_borrower"]).default("primary"),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const { leadId } = await params;
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

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

    const result = await runNbfcDocVerification({
      leadId,
      docKey: parsed.data.doc_key,
      docFor: parsed.data.doc_for,
    });

    // Normalise the service's error shape into an HTTP status.
    if ("status" in result && result.success === false) {
      const errText =
        typeof result.error === "string" ? result.error : result.error.message;
      return NextResponse.json({ ok: false, error: errText }, { status: result.status });
    }

    return NextResponse.json({ ok: true, result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
