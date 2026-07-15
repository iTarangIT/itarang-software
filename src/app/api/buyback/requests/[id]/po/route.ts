/**
 * GET /api/buyback/requests/:id/po — the dealer downloads their own PO PDF (U1).
 *
 * toDealerPo (src/lib/buyback/serialize.ts) tells the dealer detail page
 * WHETHER a PDF exists (`pdf_available`) but never hands back the S3 key
 * itself — a key is a capability, not data, and stays structurally absent
 * from every dealer payload (BRD M23 AC). This route is what `pdf_available`
 * points at: it re-derives the key server-side and streams the bytes, so the
 * dealer never needs to see or hold one.
 *
 * Scope, twice over: `loadOwnRequest` 404s another dealer's request before
 * this file even runs a query, and the SELECT below is additionally pinned to
 * leg=DEALER, direction=ISSUED — the PO iTarang issued TO this dealer, never
 * the one the vendor issued to us. There is exactly one such row per deal
 * (purchase_orders_deal_leg_unique), so this can never leak a sibling deal's
 * document by returning the wrong row.
 */

import { and, eq } from "drizzle-orm";

import { withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { purchaseOrders } from "@/lib/db/schema";
import { loadOwnRequest, requireDealer } from "@/lib/buyback/auth";
import { NotFoundError } from "@/lib/buyback/errors";
import { dealHeader } from "@/lib/buyback/queries";
import { BUYBACK_BUCKET } from "@/lib/buyback/storage";
import { getObject } from "@/lib/storage/s3";

export const runtime = "nodejs";

export const GET = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireDealer();
    const request = await loadOwnRequest(actor, requestId); // 404s if it isn't theirs

    const header = await dealHeader(request.id);
    if (!header) throw new NotFoundError("Deal not found.");

    const [po] = await db
      .select({ number: purchaseOrders.number, pdf_s3: purchaseOrders.pdf_s3 })
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.deal_id, header.deal_id),
          eq(purchaseOrders.leg, "DEALER"),
          eq(purchaseOrders.direction, "ISSUED"),
        ),
      )
      .limit(1);

    if (!po?.pdf_s3) {
      throw new NotFoundError("No purchase order PDF has been generated for this deal yet.");
    }

    const bytes = await getObject(BUYBACK_BUCKET, po.pdf_s3);
    if (!bytes) throw new NotFoundError("The purchase order PDF could not be found.");

    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.length),
        // ATTACHMENT, not inline — this is the dealer's copy of a document they
        // will want to keep and forward, not a preview.
        "Content-Disposition": `attachment; filename="${po.number}.pdf"`,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
);
