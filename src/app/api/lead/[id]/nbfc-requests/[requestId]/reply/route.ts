/**
 * POST /api/lead/[id]/nbfc-requests/[requestId]/reply   (application/json)
 *
 * E-239 — the dealer answers a direct NBFC document request from the Step-4
 * pre-sanction card: attaches files, types a note, or both. The wrapper flips
 * straight to 'pushed_to_nbfc' (no admin review), so the NBFC's existing
 * "Acknowledge & close" button lights up on its thread.
 *
 * Files are uploaded first through POST /api/lead/[id]/pre-sanction-doc, which
 * already owns storage, the 50 MB cap and the combine-to-PDF path; this route
 * receives the resulting bucket items. They are stored on the message row AND
 * best-effort appended to product_selections.pre_sanction_doc_urls so they also
 * surface in the NBFC dossier and admin product review.
 *
 * THE 10-ITEM CAP DOES NOT GATE THE REPLY. That cap belongs to the pre-sanction
 * bucket, which is a dealer-curated attachment list; a lender's direct question
 * must still be answerable when the bucket happens to be full. So a reply always
 * succeeds and the message row always keeps the files — only the mirror into
 * pre_sanction_doc_urls is skipped, and the response says so.
 *
 * Role: dealer, must own the lead.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, nbfcDocRequests, productSelections } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import {
  appendRequestMessage,
  markDirectRequestAnswered,
  NBFC_DOC_STATUS,
  type RequestAttachment,
} from "@/lib/nbfc/doc-requests";
import { notifyDealerRepliedToNbfc } from "@/lib/notifications/events";
import { dealerDisplayName } from "@/lib/notifications/emit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BUCKET_ITEMS = 10;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; requestId: string }> },
) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId, requestId } = await params;

    const [lead] = await db
      .select({ id: leads.id, dealer_id: leads.dealer_id })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!lead) {
      return NextResponse.json({ ok: false, error: "Lead not found" }, { status: 404 });
    }
    if (lead.dealer_id !== user.dealer_id) {
      return NextResponse.json({ ok: false, error: "Access denied" }, { status: 403 });
    }

    let body: { message?: unknown; items?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "Expected JSON body" }, { status: 400 });
    }

    const message = typeof body.message === "string" ? body.message.trim().slice(0, 4000) : "";
    const rawItems = Array.isArray(body.items) ? body.items : [];
    const items: RequestAttachment[] = rawItems
      .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
      .map((it) => ({
        url: String(it.url ?? ""),
        name: String(it.name ?? "file"),
        type: String(it.type ?? "application/octet-stream"),
        size: Number(it.size ?? 0) || 0,
      }))
      .filter((it) => it.url)
      .slice(0, MAX_BUCKET_ITEMS);

    if (!message && items.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Attach a document or write a message" },
        { status: 400 },
      );
    }

    // The request must be a DIRECT one on THIS lead. Scoping by lead_id is what
    // stops a dealer who owns lead A from posting into lead B's thread.
    const [wrapper] = await db
      .select({
        id: nbfcDocRequests.id,
        tenant_id: nbfcDocRequests.tenant_id,
        status: nbfcDocRequests.status,
        dealer_direct: nbfcDocRequests.dealer_direct,
      })
      .from(nbfcDocRequests)
      .where(
        and(
          eq(nbfcDocRequests.id, requestId),
          eq(nbfcDocRequests.lead_id, leadId),
          eq(nbfcDocRequests.dealer_direct, true),
        ),
      )
      .limit(1);
    if (!wrapper) {
      return NextResponse.json(
        { ok: false, error: "Request not found for this lead" },
        { status: 404 },
      );
    }
    if (wrapper.status === NBFC_DOC_STATUS.CLOSED) {
      return NextResponse.json(
        { ok: false, error: "The lender has closed this request" },
        { status: 400 },
      );
    }

    await appendRequestMessage({
      requestId,
      leadId,
      party: "dealer",
      authorUserId: user.id,
      message: message || null,
      attachments: items,
    });
    await markDirectRequestAnswered(requestId);

    // Mirror the files into the Step-4 bucket so they also show in the NBFC
    // dossier and admin product review. Best-effort and cap-aware — see header.
    let mirrored = false;
    let bucket: RequestAttachment[] = [];
    if (items.length > 0) {
      try {
        const [row] = await db
          .select({
            id: productSelections.id,
            pre_sanction_doc_urls: productSelections.pre_sanction_doc_urls,
          })
          .from(productSelections)
          .where(eq(productSelections.lead_id, leadId))
          .orderBy(desc(productSelections.created_at))
          .limit(1);
        if (row) {
          const existing = Array.isArray(row.pre_sanction_doc_urls)
            ? (row.pre_sanction_doc_urls as RequestAttachment[])
            : [];
          const known = new Set(existing.map((d) => d.url));
          const next = [...existing, ...items.filter((it) => !known.has(it.url))];
          if (next.length <= MAX_BUCKET_ITEMS && next.length !== existing.length) {
            await db
              .update(productSelections)
              .set({ pre_sanction_doc_urls: next, updated_at: new Date() })
              .where(eq(productSelections.id, row.id));
            mirrored = true;
            bucket = next;
          } else {
            bucket = existing;
          }
        }
      } catch {
        // best-effort — the message row already carries the files.
      }
    }

    await notifyDealerRepliedToNbfc({
      leadId,
      requestId,
      tenantId: wrapper.tenant_id,
      dealerName: await dealerDisplayName(user.dealer_id),
      count: items.length,
    }).catch(() => {});

    return NextResponse.json({ ok: true, mirrored, bucket });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Reply failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
