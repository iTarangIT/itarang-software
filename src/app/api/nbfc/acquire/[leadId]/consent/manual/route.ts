/**
 * POST /api/nbfc/acquire/[leadId]/consent/manual
 *
 * Manual DPDP consent — the customer/co-borrower signs the NBFC's OWN consent
 * template (uploaded once in Settings) by wet/manual signature. The NBFC no
 * longer uploads a per-lead document; the template is the document to be signed.
 * A `consent_records` row is written (sign_method='manual', pointing at the
 * template) and an `nbfc_doc_requests` wrapper (type 'manual_consent') is raised
 * so the request rides the existing Acquire loop:
 *
 *   NBFC sends → Admin reviews (NBFC Actions) → Forward to dealer → customer
 *   signs the template → Dealer returns the signed copy → Admin reviews →
 *   pushes back to NBFC → NBFC verifies.
 *
 * Body: application/json — { consentFor, comments? }
 * Role: credit_underwriting | nbfc_admin, scoped to the acting tenant.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { consentRecords, nbfcServiceConfig } from "@/lib/db/schema";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import {
  createNbfcDocRequest,
  NBFC_DOC_STATUS,
} from "@/lib/nbfc/doc-requests";
import { notifyAdminsOfNbfcRequest } from "@/lib/nbfc/doc-request-notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

function newConsentId(now: Date): string {
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = Math.floor(Math.random() * 10000).toString().padStart(4, "0");
  return `CONSENT-${dateStr}-${seq}`;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const { leadId } = await params;

    const actor = await resolveActor(req.headers);
    if (actor.role !== "credit_underwriting" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role '${actor.role}' cannot initiate consent` },
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

    let body: { consentFor?: unknown; comments?: unknown } = {};
    try {
      body = (await req.json()) as { consentFor?: unknown; comments?: unknown };
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }
    const consentFor = String(body.consentFor ?? "customer") === "borrower" ? "co_borrower" : "primary";
    const note = (typeof body.comments === "string" ? body.comments : "").trim();

    // The manual signature is taken on the NBFC's own consent template.
    const [cfg] = await db
      .select({ url: nbfcServiceConfig.consent_template_url })
      .from(nbfcServiceConfig)
      .where(eq(nbfcServiceConfig.tenant_id, actor.tenant_id))
      .limit(1);
    if (!cfg?.url) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "BAD_REQUEST: no consent template configured. Upload your consent document in Settings first.",
        },
        { status: 400 },
      );
    }
    const url = cfg.url;

    const now = new Date();
    // Record the manual consent as an awaiting-signature row on the template.
    const consentId = newConsentId(now);
    await db.insert(consentRecords).values({
      id: consentId,
      lead_id: leadId,
      consent_for: consentFor,
      consent_type: "manual",
      sign_method: "manual",
      consent_status: "awaiting_signature",
      generated_pdf_url: url,
      initiated_by_tenant_id: actor.tenant_id,
      created_at: now,
      updated_at: now,
    });

    // Raise the request into the existing Acquire loop so the admin can review
    // (in NBFC Actions) and forward the template to the dealer for the customer's
    // wet signature. Comments carry the applicant + method + the document link.
    const applicantLabel = consentFor === "co_borrower" ? "co-borrower" : "customer";
    const wrapperComments = [
      `Manual DPDP consent for the ${applicantLabel} — method: manual (wet) signature.`,
      `Please forward the consent document to the dealer to obtain the ${applicantLabel}'s signature and return the signed copy.`,
      `Document: ${url}`,
      note ? `NBFC note: ${note}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const { id } = await createNbfcDocRequest({
      leadId,
      assignmentId: assignment.id,
      nbfcId: assignment.nbfc_id,
      tenantId: actor.tenant_id,
      requestType: "manual_consent",
      docFor: consentFor,
      targetDocKey: "manual_consent",
      comments: wrapperComments,
      raisedBy: actor.user_id,
      initialStatus: NBFC_DOC_STATUS.RAISED,
    });

    // Best-effort: notify + email the admins (with an act link).
    await notifyAdminsOfNbfcRequest({
      leadId,
      requestId: id,
      requestType: "manual_consent",
      nbfcName: actor.tenant_slug,
      comments: note || null,
      req,
    }).catch(() => {});

    return NextResponse.json({ ok: true, id, consentId, url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
