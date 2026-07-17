/**
 * POST /api/vendor/threads/:id/po   (E-196, BRD step 2)
 *
 * The vendor raises their own PO to iTarang, first-hand.
 *
 * On the vendor leg the vendor is the BUYER, and the buyer initiates the PO.
 * Until now this reached the system only as an admin RECORDING what the vendor
 * emailed; with a login, the vendor does it themselves. Both go through the same
 * lib (recordVendorPo) — what differs is the actor, which decides the audit
 * action (submit_vendor_po vs record_vendor_po) and nothing else.
 *
 * AUTHORISATION IS THIS FILE'S JOB. loadOwnThread scopes by the caller's own
 * accounts.id in the query, and a miss is 404 — a 403 would confirm the thread
 * exists, and a vendor who can enumerate thread ids can map our deal flow. The
 * thread must be AGREED: a vendor cannot raise a PO for a lot they have not won.
 *
 * The state guard is the state machine's: exchange_pos is legal only from
 * VENDOR_AGREED, for the vendor role (E-196 widened that edge). A vendor posting
 * against a deal that has moved on gets a TransitionError, not a wrong write.
 */

import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { requireVendor } from "@/lib/buyback/auth";
import { NotFoundError, ValidationError } from "@/lib/buyback/errors";
import { recordVendorPo } from "@/lib/buyback/po";
import { loadOwnThread, threadContextFor } from "@/lib/buyback/vendors";

export const runtime = "nodejs";

const bodySchema = z.object({
  /** The vendor's own PO number, on their series — not ours. */
  number: z.string().trim().min(1).max(120),
  /**
   * S3 key of the PO PDF the vendor uploaded via the same-origin proxy
   * (/api/buyback/uploads, kind='vendor_po'). Optional: the number is the
   * record; the PDF is supporting evidence.
   */
  pdf_s3: z.string().trim().max(500).optional(),
});

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: threadId } = await ctx.params;
    const actor = await requireVendor();
    const body = bodySchema.parse(await req.json());

    // Ownership, scoped in the query. Not "load then check".
    const own = await loadOwnThread(actor.entityId!, threadId);
    if (!own) throw new NotFoundError("Quotation not found.");
    if (own.status !== "AGREED") {
      throw new ValidationError(
        "You can only raise a purchase order once your quotation has been agreed.",
      );
    }

    const thread = await threadContextFor(threadId);

    const outcome = await db.transaction((tx) =>
      recordVendorPo({
        tx,
        requestId: thread.requestId,
        number: body.number,
        pdfS3: body.pdf_s3,
        actor: { id: actor.id, role: "vendor" },
        requestNo: thread.requestNo,
      }),
    );

    // The vendor learns their own outcome — that the PO landed, and whether it
    // completed the exchange — and nothing about the dealer side.
    return successResponse({
      thread_id: threadId,
      po_id: outcome.po_id,
      number: outcome.number,
      exchanged: outcome.exchanged,
    });
  },
);
