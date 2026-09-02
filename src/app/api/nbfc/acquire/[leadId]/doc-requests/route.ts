/**
 * GET/POST /api/nbfc/acquire/[leadId]/doc-requests
 *
 * The NBFC's document-request thread for a lead (Change 2 & 3).
 *   GET  → the thread (wrappers + children) scoped to the acting tenant.
 *   POST → raise a new request (correction | additional_docs | step4_extra_items).
 *
 * Role: `credit_underwriting` (owns verification/offer terms, §7.2) or `nbfc_admin`.
 *
 * ONE routing: every request lands with the iTarang admin ('nbfc_raised'), who
 * either answers it himself via /api/admin/nbfc-requests/[id]/fulfil (he already
 * holds the document) or forwards it to the dealer/customer via
 * /api/admin/nbfc-requests/[id]/forward and pushes the reviewed file back.
 *
 * This retires the E-240 direct-to-dealer routing: `route_to: 'dealer'` is now
 * rejected with a 400. Threads raised under it before this stay readable and
 * repliable through the [id]/reply route — only new ones are refused.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { dealerDisplayName } from "@/lib/notifications/emit";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import {
  createNbfcDocRequest,
  listThreadForLead,
  NBFC_DOC_STATUS,
} from "@/lib/nbfc/doc-requests";
import { notifyAdminsOfNbfcRequest } from "@/lib/nbfc/doc-request-notify";
import { sendNbfcEventEmail } from "@/lib/nbfc/event-mailer";

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
  // Kept in the contract only so an old client gets a clear 400 instead
  // of a silent re-route; 'admin' is the only routing that still exists.
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

    // The admin is the single gate; nothing may be written straight to
    // the dealer any more.
    if (d.route_to === "dealer") {
      return NextResponse.json(
        {
          ok: false,
          error:
            "BAD_REQUEST: direct-to-dealer requests are retired — every document request is routed through the iTarang admin",
        },
        { status: 400 },
      );
    }

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

    // E-276 — confirmation copy to the raising NBFC (+ global monitoring CC).
    const requestLabel =
      d.request_type === "correction"
        ? "Correction request"
        : d.request_type === "additional_docs"
          ? "Additional documents request"
          : d.request_type === "co_borrower"
            ? "Co-borrower request"
            : "Document request";
    (async () => {
      const [leadRow] = await db
        .select({
          full_name: leads.full_name,
          owner_name: leads.owner_name,
          dealer_id: leads.dealer_id,
        })
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1);
      await sendNbfcEventEmail({
        tenantId: actor.tenant_id,
        leadId,
        subject: `iTarang — ${requestLabel} raised for Lead ${leadId}`,
        eventLabel: `Your ${requestLabel.toLowerCase()} for Lead ${leadId} has been raised and routed to the iTarang admin.`,
        customerName: leadRow?.full_name ?? leadRow?.owner_name ?? null,
        dealerName: await dealerDisplayName(leadRow?.dealer_id),
        files: (d.items ?? []).map((it) =>
          it.reason ? `${it.doc_label} — ${it.reason}` : it.doc_label,
        ),
        extraRows: [
          ["Request type", requestLabel],
          ["Comments", d.comments],
        ],
        bodyHtml: `<p>Update: the admin will either fulfil the request himself or forward it to the dealer; you will be emailed again when the documents are pushed back to your dashboard.</p>`,
      });
    })().catch(() => {});

    return NextResponse.json({ ok: true, id, routed_to: "admin" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
