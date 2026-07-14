/**
 * /api/buyback/requests
 *
 * POST — open a DRAFT request (+ its batch and its deal row). The deal is
 *        created here, at DRAFT, because buyback_deals.status is the single
 *        source of truth for state (BRD §2) — a request without a deal would
 *        have nowhere to hold its status.
 * GET  — the caller's own requests (M01). Entity-scoped: a dealer cannot see,
 *        or even detect, another dealer's request.
 */

import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { buybackBatches, buybackDeals, buybackRequests } from "@/lib/db/schema";
import { requireDealer } from "@/lib/buyback/auth";
import { nextRequestNo } from "@/lib/buyback/request-no";

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
    })
    .from(buybackRequests)
    .innerJoin(buybackDeals, eq(buybackDeals.request_id, buybackRequests.id))
    // The scope. Not a post-fetch check — part of the query.
    .where(eq(buybackRequests.dealer_entity_id, actor.entityId!))
    .orderBy(desc(buybackRequests.created_at));

  return successResponse({ requests: rows });
});
