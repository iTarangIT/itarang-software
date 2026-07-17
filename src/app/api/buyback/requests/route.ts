/**
 * /api/buyback/requests
 *
 * POST — open a DRAFT request (+ its batch and its deal row). The deal is
 *        created here, at DRAFT, because buyback_deals.status is the single
 *        source of truth for state (BRD §2) — a request without a deal would
 *        have nowhere to hold its status.
 * GET  — the caller's own requests (M01). Entity-scoped: a dealer cannot see,
 *        or even detect, another dealer's request.
 *
 *        Ext-8/Ext-9 (additive): each row also carries
 *          · pickup — the latest pickup on the request's batch, dealer-safe
 *            fields only, via toDealerPickup(); null until one is scheduled;
 *          · payout — the dealer's OWN money leg (locked total, -D settlement
 *            existence, its txn_ref), via toDealerPayout(); null until the
 *            deal reaches the money stage.
 *        Both are built by serializers with their own release-blocking
 *        contract tests; the batch reads live in lib (money.ts / pickup.ts),
 *        so this file never touches the locks or settlement tables.
 */

import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { buybackBatches, buybackDeals, buybackRequests } from "@/lib/db/schema";
import { requireDealer } from "@/lib/buyback/auth";
import { dealerPayoutSourcesForEntity } from "@/lib/buyback/money";
import { dealerPickupSourcesForEntity } from "@/lib/buyback/pickup";
import { draftBlockersFor, draftBlockersForEntity } from "@/lib/buyback/queries";
import { nextRequestNo } from "@/lib/buyback/request-no";
import { toDealerPayout, toDealerPickup } from "@/lib/buyback/serialize";
import type { GateIssue } from "@/lib/buyback/submit-gate";

export const runtime = "nodejs";

const createSchema = z.object({
  pickup_address_id: z.string().uuid().nullish(),
  source_channel: z.enum(["WEB", "WHATSAPP", "CSV"]).default("WEB"),
});

export const POST = withErrorHandler(async (req: Request) => {
  const actor = await requireDealer();
  const body = createSchema.parse(await req.json().catch(() => ({})));

  const created = await db.transaction(async (tx) => {
    const requestNo = await nextRequestNo(tx);

    const [request] = await tx
      .insert(buybackRequests)
      .values({
        request_no: requestNo,
        dealer_entity_id: actor.entityId!,
        source_channel: body.source_channel,
        created_by: actor.id,
      })
      .returning();

    // Sprint 1 is one batch per request (order-level pickup). Per-batch and
    // per-line pickup is M05, Sprint 3 — the hierarchy is already in the schema.
    const [batch] = await tx
      .insert(buybackBatches)
      .values({
        request_id: request.id,
        pickup_address_id: body.pickup_address_id ?? null,
      })
      .returning();

    const [deal] = await tx
      .insert(buybackDeals)
      .values({ request_id: request.id, status: "DRAFT" })
      .returning();

    // No applyTransition here: nothing transitioned. The deal is BORN at DRAFT,
    // and creating a draft is not a state change anyone needs to hear about.
    return { request, batch, deal };
  });

  return successResponse(
    {
      request_id: created.request.id,
      request_no: created.request.request_no,
      batch_id: created.batch.id,
      status: created.deal.status,
    },
    201,
  );
});

export const GET = withErrorHandler(async () => {
  const actor = await requireDealer();

  const rows = await db
    .select({
      request_id: buybackRequests.id,
      request_no: buybackRequests.request_no,
      status: buybackDeals.status,
      offer_version: buybackDeals.offer_version,
      source_channel: buybackRequests.source_channel,
      created_at: buybackRequests.created_at,
      submitted_at: buybackRequests.submitted_at,
      line_count: sql<number>`(
        SELECT count(*)::int FROM buyback_lines bl
        JOIN buyback_batches bb ON bb.id = bl.batch_id
        WHERE bb.request_id = ${buybackRequests.id}
      )`,
      total_units: sql<number>`(
        SELECT coalesce(sum(bl.quantity), 0)::int FROM buyback_lines bl
        JOIN buyback_batches bb ON bb.id = bl.batch_id
        WHERE bb.request_id = ${buybackRequests.id}
      )`,
      // The dealer's own asking value, derived from the LINES (never stored on
      // the request — same invariant, same subquery shape as the admin queue's
      // dealer_quote (src/app/api/admin/buyback/queue/route.ts). Cast to
      // ::float8 rather than left as the bare numeric aggregate — postgres.js
      // returns NUMERIC as a string, which would silently type as `number`
      // here (sql<number> is a compile-time label only) but arrive as a string
      // over the wire.
      dealer_quote: sql<number>`(
        SELECT coalesce(sum(bl.quantity * bl.expected_price_per_unit), 0)::float8 FROM buyback_lines bl
        JOIN buyback_batches bb ON bb.id = bl.batch_id
        WHERE bb.request_id = ${buybackRequests.id}
      )`,
    })
    .from(buybackRequests)
    .innerJoin(buybackDeals, eq(buybackDeals.request_id, buybackRequests.id))
    // The scope. Not a post-fetch check — part of the query.
    .where(eq(buybackRequests.dealer_entity_id, actor.entityId!))
    .orderBy(desc(buybackRequests.created_at));

  if (rows.length === 0) {
    return successResponse({ requests: [] });
  }

  // Ext-8/Ext-9 — two batch reads for the whole list (both entity-scoped by
  // the same dealer_entity_id, in lib), then per-row serialization. The
  // serializers are the redaction boundary: only their output shapes reach
  // the wire.
  // E-194 adds a third: why each DRAFT can't be submitted. Only fetched when
  // the dealer actually has a draft — the common case is none, and there is no
  // point querying lines for a list that has nothing to explain.
  const hasDrafts = rows.some((r) => r.status === "DRAFT");

  const [pickupByRequest, payoutByRequest, draftBlockers] = await Promise.all([
    dealerPickupSourcesForEntity(actor.entityId!),
    dealerPayoutSourcesForEntity(actor.entityId!),
    hasDrafts
      ? draftBlockersForEntity(actor.entityId!)
      : Promise.resolve(new Map<string, GateIssue[]>()),
  ]);

  const requests = rows.map((r) => ({
    ...r,
    pickup: toDealerPickup(pickupByRequest.get(r.request_id) ?? null),
    payout: toDealerPayout({
      locked_dealer_total: payoutByRequest.get(r.request_id)?.locked_dealer_total ?? null,
      settlements: payoutByRequest.get(r.request_id)?.settlements ?? [],
    }),
    // Null for anything already submitted — the question only applies to a
    // draft, and an empty array there would read as "nothing is blocking it".
    draft_blockers:
      r.status === "DRAFT" ? draftBlockersFor(draftBlockers, r.request_id) : null,
  }));

  return successResponse({ requests });
});
