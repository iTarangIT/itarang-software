/**
 * POST /api/admin/buyback/requests/:id/reopen
 *
 * Dealer acceptance is PROVISIONAL until a vendor agrees (BRD §2). Until then an
 * admin may reopen the negotiation; after VENDOR_AGREED they may not, ever — the
 * margin is committed against a vendor at that point and moving the dealer price
 * would silently change a deal iTarang has already sold.
 *
 * That boundary is enforced by the state machine, not by this route: `reopen` has
 * no edge out of VENDOR_AGREED, so the call 409s (M07 AC: "reopen after vendor
 * agreement rejected server-side").
 *
 * Reopening bumps offer_version. Locks and final offers are stamped with the
 * version they belong to, so the old generation stops being read but stays on
 * disk for the audit trail.
 *
 * SPRINT 2A — reopening after ROUTING (VENDOR_ROUTED / VENDOR_NEGOTIATING is
 * still before agreement, so it is legal) leaves live quotations sitting in
 * vendors' inboxes for prices that are about to move. Every open thread is
 * therefore closed LOST in the same transaction, and each of those vendors is
 * told. Leaving them open would mean a vendor could "accept" a quotation we no
 * longer stand behind.
 */

import { and, eq, notInArray } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { vendorThreads } from "@/lib/db/schema";
import { loadAnyRequest, requireBuybackAdmin } from "@/lib/buyback/auth";
import { NotFoundError } from "@/lib/buyback/errors";
import { applyTransition, loadDealForUpdate } from "@/lib/buyback/transition";
import { threadsForDeal } from "@/lib/buyback/vendors";

export const runtime = "nodejs";

const bodySchema = z.object({
  reason: z.string().max(2000).nullish(),
});

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireBuybackAdmin();
    const request = await loadAnyRequest(requestId);
    const body = bodySchema.parse(await req.json().catch(() => ({})));

    const outcome = await db.transaction(async (tx) => {
      const deal = await loadDealForUpdate(tx, request.id);
      if (!deal) throw new NotFoundError("Deal not found.");

      // Who is mid-quotation right now, before we close them (we need their
      // addresses to tell them, and the rows are about to say LOST).
      const open = (await threadsForDeal(deal.id, tx)).filter(
        (t) => t.status === "SENT" || t.status === "COUNTERED",
      );

      if (open.length > 0) {
        await tx
          .update(vendorThreads)
          .set({
            status: "LOST",
            close_reason: "dealer leg reopened — prices withdrawn",
            closed_at: new Date(),
            updated_at: new Date(),
          })
          .where(
            and(
              eq(vendorThreads.deal_id, deal.id),
              notInArray(vendorThreads.status, ["AGREED", "LOST"]),
            ),
          );
      }

      const result = await applyTransition({
        tx,
        dealId: deal.id,
        requestId: request.id,
        currentStatus: deal.status,
        offerVersion: deal.offer_version,
        action: "reopen",
        actor: { id: actor.id, role: "admin" },
        // The version bump IS the reopen. Doing it inside applyTransition keeps
        // it in the same transaction as the status change and the audit row.
        bumpOfferVersion: true,
        before: { status: deal.status, offer_version: deal.offer_version },
        after: {
          status: "NEGOTIATING",
          offer_version: deal.offer_version + 1,
          withdrawn_quotations: open.length,
        },
        // The dealer hears that we are reopening; every vendor whose quotation we
        // just withdrew hears that it is closed. They must NOT be told why — that
        // we are renegotiating the buy price is our business, not theirs.
        fanOut: [
          {
            party: "DEALER",
            channel: "WHATSAPP",
            discriminator: "dealer",
            payload: {
              request_no: request.request_no,
              new_version: deal.offer_version + 1,
              reason: body.reason ?? null,
            },
          },
          ...open
            .filter((t) => t.vendor_email)
            .map((t) => ({
              party: "VENDOR" as const,
              channel: "EMAIL" as const,
              recipientRef: t.vendor_email,
              discriminator: `withdrawn:${t.id}`,
              payload: {
                kind: "vendor_lost",
                thread_id: t.id,
                vendor_name: t.vendor_name,
                quotation_no: t.quotation_no,
              },
            })),
        ],
      });

      return { result, withdrawn: open.length };
    });

    return successResponse({
      request_id: request.id,
      status: outcome.result.to,
      offer_version: outcome.result.offerVersion,
      withdrawn_quotations: outcome.withdrawn,
    });
  },
);
