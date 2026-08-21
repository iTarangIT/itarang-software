/**
 * GET/POST /api/nbfc/acquire/[leadId]/doc-requests
 *
 * The NBFC's document-request thread for a lead (Change 2 & 3).
 *   GET  → the thread (wrappers + children) scoped to the acting tenant.
 *   POST → raise a new request (correction | additional_docs | step4_extra_items).
 *
 * Role: `credit_underwriting` (owns verification/offer terms, §7.2) or `nbfc_admin`.
 *
 * Two routings, chosen by `route_to`:
 *   'admin'  (default) — the original E-200 path. Status 'nbfc_raised'; the admin
 *                        forwards it via /api/admin/nbfc-requests/[id]/forward.
 *   'dealer'           — E-240. Straight to the dealer's Step-4 pre-sanction
 *                        card, no admin click in between. Admins are still
 *                        notified and still see the whole thread.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import {
  createDirectDealerRequest,
  createNbfcDocRequest,
  listThreadForLead,
  NBFC_DOC_STATUS,
} from "@/lib/nbfc/doc-requests";
import { notifyAdminsOfNbfcRequest } from "@/lib/nbfc/doc-request-notify";
import { notifyNbfcDocRequestDirect } from "@/lib/notifications/events";

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
  request_type: z.enum([
    "correction",
    "additional_docs",
    "step4_extra_items",
    "co_borrower",
  ]),
  doc_for: z.enum(["primary", "co_borrower"]).default("primary"),
  target_doc_key: z.string().max(120).optional().nullable(),
  comments: z.string().max(4000).optional().nullable(),
  // E-240 — 'dealer' skips the admin forward gate. Defaults to the original
  // admin-gated behaviour, so every existing caller is unaffected.
  route_to: z.enum(["admin", "dealer"]).default("admin"),
  // E-254 — the structured items behind an additional-documents request, kept
  // beside the serialised `comments` so an SLA auto-forward creates exactly
  // the children a human would have. Optional: every existing caller omits it.
  items: z
    .array(
      z.object({
        doc_label: z.string().min(1).max(200),
        reason: z.string().max(2000).optional().nullable(),
        is_required: z.boolean().optional(),
      }),
    )
    .max(10)
    .optional(),
});

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
    const thread = await listThreadForLead(leadId, { tenantId: actor.tenant_id });
    return NextResponse.json({ ok: true, thread });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}

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
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const d = parsed.data;

    const actor = await resolveActor(req.headers);
    if (actor.role !== "credit_underwriting" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        {
          ok: false,
          error: `FORBIDDEN: role '${actor.role}' cannot raise a document request; credit_underwriting or nbfc_admin required`,
        },
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

    // E-240 — direct to the dealer. The comment IS the request here (there are
    // no structured items to forward), so it is required rather than optional.
    if (d.route_to === "dealer") {
      const comments = (d.comments ?? "").trim();
      if (!comments) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "BAD_REQUEST: a message is required when sending a request straight to the dealer",
          },
          { status: 400 },
        );
      }
      const { id } = await createDirectDealerRequest({
        leadId,
        assignmentId: assignment.id,
        nbfcId: assignment.nbfc_id,
        tenantId: actor.tenant_id,
        docFor: d.doc_for,
        comments,
        raisedBy: actor.user_id,
      });
      await notifyNbfcDocRequestDirect({
        leadId,
        requestId: id,
        nbfcName: actor.tenant_slug,
        comments,
      }).catch(() => {});
      return NextResponse.json({ ok: true, id, routed_to: "dealer" });
    }

    const { id } = await createNbfcDocRequest({
      leadId,
      assignmentId: assignment.id,
      nbfcId: assignment.nbfc_id,
      tenantId: actor.tenant_id,
      requestType: d.request_type,
      docFor: d.doc_for,
      targetDocKey: d.target_doc_key ?? null,
      comments: d.comments ?? null,
      raisedBy: actor.user_id,
      initialStatus: NBFC_DOC_STATUS.RAISED,
      requestedItems: d.items?.map((it) => ({
        doc_label: it.doc_label,
        reason: it.reason ?? undefined,
        is_required: it.is_required ?? true,
      })),
    });

    // Best-effort: notify + email the admins (act link).
    await notifyAdminsOfNbfcRequest({
      leadId,
      requestId: id,
      requestType: d.request_type,
      nbfcName: actor.tenant_slug,
      comments: d.comments ?? null,
      req,
    }).catch(() => {});

    return NextResponse.json({ ok: true, id, routed_to: "admin" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
