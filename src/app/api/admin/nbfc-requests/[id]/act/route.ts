/**
 * GET/POST /api/admin/nbfc-requests/[id]/act
 *
 * The "act from email" landing endpoint (Change 5). The email carries a
 * tokenised link to /nbfc-request-action/[id]?token=… ; that confirm page uses
 * this endpoint.
 *
 *   GET  ?token=  → validate the token, return the request + its items so the
 *                   confirm page can render Forward / Push / Decline.
 *   POST { token, action, items?, adminNotes? } → perform the action.
 *
 * Security: the token (sha256 compared to nbfc_doc_requests.act_token_hash,
 * with expiry) proves the link came from our email and scopes to THIS request;
 * an admin session is ALSO required for attribution (reviewed_by). The token is
 * single-use — invalidated after a successful forward/push/decline.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { nbfcDocRequests, otherDocumentRequests } from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { hashActToken } from "@/lib/nbfc/act-token";
import {
  declineNbfcDocRequest,
  forwardNbfcDocRequest,
  pushNbfcDocRequest,
  NBFC_DOC_STATUS_LABEL,
} from "@/lib/nbfc/doc-requests";
import { notifyDealerForLead } from "@/lib/notifications";
import { notifyNbfcOfUpdate } from "@/lib/nbfc/doc-request-notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function loadByToken(id: string, token: string) {
  const [wrapper] = await db
    .select()
    .from(nbfcDocRequests)
    .where(eq(nbfcDocRequests.id, id))
    .limit(1);
  if (!wrapper) return { error: "NOT_FOUND", wrapper: null as null };
  if (
    !wrapper.act_token_hash ||
    wrapper.act_token_hash !== hashActToken(token) ||
    !wrapper.act_token_expires_at ||
    new Date(wrapper.act_token_expires_at).getTime() < Date.now()
  ) {
    return { error: "INVALID_TOKEN", wrapper: null as null };
  }
  return { error: null as null, wrapper };
}

const ItemSchema = z.object({
  doc_label: z.string().min(1),
  doc_key: z.string().min(1).optional(),
  is_required: z.boolean().default(true),
  reason: z.string().optional(),
});

const Body = z.object({
  token: z.string().min(1),
  action: z.enum(["forward", "push", "decline"]),
  items: z.array(ItemSchema).optional(),
  adminNotes: z.string().max(4000).optional().nullable(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const { error, wrapper } = await loadByToken(id, token);
  if (error || !wrapper) {
    return NextResponse.json({ ok: false, error }, { status: error === "NOT_FOUND" ? 404 : 401 });
  }
  const items = await db
    .select()
    .from(otherDocumentRequests)
    .where(eq(otherDocumentRequests.nbfc_request_id, id));
  return NextResponse.json({
    ok: true,
    request: wrapper,
    items,
    status_label: NBFC_DOC_STATUS_LABEL[wrapper.status] ?? wrapper.status,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const { token, action, items, adminNotes } = parsed.data;

    const { error, wrapper } = await loadByToken(id, token);
    if (error || !wrapper) {
      return NextResponse.json({ ok: false, error }, { status: error === "NOT_FOUND" ? 404 : 401 });
    }

    // Attribution: an admin session is required so reviewed_by is real.
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json(
        { ok: false, error: "UNAUTHORIZED: please sign in as an admin to action this request" },
        { status: 401 },
      );
    }

    let result: unknown = null;
    if (action === "decline") {
      await declineNbfcDocRequest({ requestId: id, adminUserId: appUser.id, adminNotes: adminNotes ?? null });
      result = { status: "rejected" };
    } else if (action === "forward") {
      if (!items || items.length === 0) {
        return NextResponse.json(
          { ok: false, error: "BAD_REQUEST: forward requires at least one item" },
          { status: 400 },
        );
      }
      const fwd = await forwardNbfcDocRequest({
        requestId: id,
        adminUserId: appUser.id,
        items,
        adminNotes: adminNotes ?? null,
      });
      await notifyDealerForLead({
        leadId: wrapper.lead_id,
        type: "nbfc_doc_request_forwarded",
        title: "Documents requested",
        message: `An NBFC has requested ${fwd.requests.length} document(s) for this lead.`,
        data: { requestId: id },
      }).catch(() => {});
      result = fwd;
    } else {
      await pushNbfcDocRequest({ requestId: id, adminUserId: appUser.id });
      await notifyNbfcOfUpdate({
        tenantId: wrapper.tenant_id,
        leadId: wrapper.lead_id,
        requestId: id,
      }).catch(() => {});
      result = { status: "pushed_to_nbfc" };
    }

    // Single-use: burn the token.
    await db
      .update(nbfcDocRequests)
      .set({ act_token_hash: null, act_token_expires_at: null, updated_at: new Date() })
      .where(eq(nbfcDocRequests.id, id));

    return NextResponse.json({ ok: true, result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.startsWith("BAD_REQUEST") ? 400 : msg.startsWith("NOT_FOUND") ? 404 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
