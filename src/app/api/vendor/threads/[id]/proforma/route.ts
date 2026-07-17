/**
 * GET /api/vendor/threads/:id/proforma   (E-196, step 4)
 *
 * Streams the vendor their own proforma PDF — the document they pay against.
 *
 * A DEDICATED vendor route rather than a `?proforma=` branch on
 * /api/buyback/media: that route is dealer/admin-scoped and bails on
 * `!isAdmin && !dealerEntityId`, so a vendor cannot reach it, and widening its
 * scoping guard to admit vendors is exactly the kind of one-COALESCE-from-
 * matching-everything change its own comment warns against. This route scopes
 * the way the rest of /api/vendor/* does — by the caller's own accounts.id.
 *
 * loadOwnThread confirms the thread is theirs (404 on a miss, never 403), then
 * the proforma is fetched by that thread's deal. A vendor can only ever pull the
 * PDF for a lot routed to them.
 */

import { and, eq } from "drizzle-orm";

import { withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { proformaInvoices } from "@/lib/db/schema";
import { requireVendor } from "@/lib/buyback/auth";
import { NotFoundError } from "@/lib/buyback/errors";
import { BUYBACK_BUCKET } from "@/lib/buyback/storage";
import { loadOwnThread, threadContextFor } from "@/lib/buyback/vendors";
import { getObject } from "@/lib/storage/s3";

export const runtime = "nodejs";

export const GET = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: threadId } = await ctx.params;
    const actor = await requireVendor();

    // Ownership, scoped in the query.
    const own = await loadOwnThread(actor.entityId!, threadId);
    if (!own) throw new NotFoundError("Not found.");

    const thread = await threadContextFor(threadId);

    const [pi] = await db
      .select({ pdf_s3: proformaInvoices.pdf_s3, number: proformaInvoices.number })
      .from(proformaInvoices)
      .where(
        and(
          eq(proformaInvoices.deal_id, thread.dealId),
          eq(proformaInvoices.status, "ISSUED"),
        ),
      )
      .limit(1);

    if (!pi?.pdf_s3) throw new NotFoundError("Not found.");

    const bytes = await getObject(BUYBACK_BUCKET, pi.pdf_s3);
    if (!bytes) throw new NotFoundError("Not found.");

    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${pi.number}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  },
);
