/**
 * POST /api/admin/buyback/requests/:id/pickup           — schedule collection
 * POST /api/admin/buyback/requests/:id/pickup/complete  — mark it collected
 *
 * PO_EXCHANGED → PICKUP_SCHEDULED → PICKED_UP.
 *
 * DELIBERATELY MINIMAL. Pickups are M05, which is Sprint 3 — but the deal has to
 * pass through these two states to reach INVOICE_RAISED, and letting it teleport
 * past states it never entered would mean rewriting the state machine (and its
 * golden fixtures) later. So Sprint 2A schedules and completes a collection, and
 * nothing more.
 *
 * The BWM 2022 compliance fields — e-way bill number, weighbridge slip, actual
 * counts, variance flag, dealer acknowledgement — are COLUMNS on `pickups`
 * already (E-186) but are neither written nor validated here. That is Sprint 3's
 * job, and it needs no migration when it arrives.
 *
 * A dealer cannot complete their own pickup: `complete_pickup` is admin-only in
 * the state machine. Self-certified collection is exactly the variance fraud M05
 * exists to catch.
 */

import { sql } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { pickups } from "@/lib/db/schema";
import { loadAnyRequest, requireBuybackAdmin } from "@/lib/buyback/auth";
import { NotFoundError } from "@/lib/buyback/errors";
import { applyTransition, loadDealForUpdate } from "@/lib/buyback/transition";

export const runtime = "nodejs";

const bodySchema = z.object({
  scheduled_at: z.string().datetime(),
  address: z.string().max(500).optional(),
  contact_name: z.string().max(120).optional(),
  contact_phone: z.string().max(20).optional(),
});

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireBuybackAdmin();
    const request = await loadAnyRequest(requestId);
    const body = bodySchema.parse(await req.json());

    const outcome = await db.transaction(async (tx) => {
      const deal = await loadDealForUpdate(tx, request.id);
      if (!deal) throw new NotFoundError("Deal not found.");

      // The batch this collection covers. Sprint 2A has one batch per request;
      // M05 (Sprint 3) makes pickups per-batch across cities, which is why the
      // column is here now.
      const batch = await tx.execute(sql`
        SELECT id FROM buyback_batches WHERE request_id = ${request.id} LIMIT 1
      `);
      const batchId =
        (batch as unknown as Array<{ id: string }>)[0]?.id ?? null;

      const [row] = await tx
        .insert(pickups)
        .values({
          deal_id: deal.id,
          batch_id: batchId,
          scope: "BATCH",
          scheduled_at: new Date(body.scheduled_at),
          address: body.address ?? null,
          contact_name: body.contact_name ?? null,
          contact_phone: body.contact_phone ?? null,
          created_by: actor.id,
        })
        .returning({ id: pickups.id });

      const result = await applyTransition({
        tx,
        dealId: deal.id,
        requestId: request.id,
        currentStatus: deal.status,
        offerVersion: deal.offer_version,
        action: "schedule_pickup",
        actor: { id: actor.id, role: "admin" },
        after: { pickup_id: row.id, scheduled_at: body.scheduled_at },
        // The dealer has to be there with the batteries, so they hear about it.
        notificationPayload: {
          request_no: request.request_no,
          scheduled_at: body.scheduled_at,
        },
      });

      return { pickupId: row.id, status: result.to };
    });

    return successResponse({
      request_id: request.id,
      pickup_id: outcome.pickupId,
      status: outcome.status,
    });
  },
);
