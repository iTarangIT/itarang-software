/**
 * GET /api/admin/buyback/requests/:id/vendor-board
 *
 * Everything the Vendor Board needs, in one call: the threads (itemized), who we
 * could still route to, the POs so far, and the pickup.
 *
 * ADMIN-ONLY, and it must stay that way — this payload is the exact inverse of
 * what a dealer may see. It carries vendor identities and the floor. There is no
 * dealer-facing variant of this endpoint, and there must never be one: the
 * dealer's view of their own deal (GET /api/buyback/requests/:id) is built by
 * toDealerDeal(), which has no field for any of this.
 */

import { eq, sql } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { purchaseOrders } from "@/lib/db/schema";
import { loadAnyRequest, requireBuybackAdmin } from "@/lib/buyback/auth";
import { NotFoundError } from "@/lib/buyback/errors";
import { dealHeader } from "@/lib/buyback/queries";
import { allowedActions } from "@/lib/buyback/state-machine";
import { listRoutableVendors, threadsForDeal } from "@/lib/buyback/vendors";

export const runtime = "nodejs";

export const GET = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    await requireBuybackAdmin();
    const request = await loadAnyRequest(requestId);

    const header = await dealHeader(request.id);
    if (!header) throw new NotFoundError("Deal not found.");

    const [threads, vendors, pos, pickupRows] = await Promise.all([
      threadsForDeal(header.deal_id),
      listRoutableVendors(),
      db
        .select({
          id: purchaseOrders.id,
          leg: purchaseOrders.leg,
          direction: purchaseOrders.direction,
          number: purchaseOrders.number,
          status: purchaseOrders.status,
          pdf_s3: purchaseOrders.pdf_s3,
        })
        .from(purchaseOrders)
        .where(eq(purchaseOrders.deal_id, header.deal_id)),
      db.execute(sql`
        SELECT id, scheduled_at, completed_at, address, contact_name, contact_phone
        FROM pickups WHERE deal_id = ${header.deal_id}
        ORDER BY created_at DESC LIMIT 1
      `),
    ]);

    const floor = Number(header.floor_total ?? 0);

    // Vendors already on the board cannot be routed to again (UNIQUE(deal,vendor)).
    const routed = new Set(threads.map((t) => t.vendor_id));

    return successResponse({
      request_id: request.id,
      request_no: request.request_no,
      deal_id: header.deal_id,
      status: header.status,
      floor_total: floor,
      allowed_actions: allowedActions(header.status, "admin"),

      threads: threads.map((t) => ({
        ...t,
        // The banner the admin acts on: this vendor cannot be agreed to as things
        // stand. Computed here, but the SERVER refuses the agreement regardless —
        // the UI is not the gate (assertClearsFloor throws a 422).
        below_floor: t.current_total !== null && t.current_total < floor,
        shortfall:
          t.current_total !== null && t.current_total < floor ? floor - t.current_total : 0,
      })),

      routable_vendors: vendors
        .filter((v) => !routed.has(v.id))
        .map((v) => ({
          id: v.id,
          name: v.name,
          email: v.email,
          city: v.city,
          state: v.state,
          categories: v.categories,
          regions: v.regions,
          payment_terms: v.payment_terms,
        })),

      purchase_orders: pos,
      pickup: (pickupRows as unknown as Array<Record<string, unknown>>)[0] ?? null,
    });
  },
);
