/**
 * GET /api/admin/buyback/documents/dealers/:entityId   (documents redesign — V5)
 *
 * Every one of a dealer's deals, newest first, each carrying its FULL document
 * set — the same set the per-request document centre shows, built by the shared
 * `buildDealDocumentSet` (so the two surfaces never drift). This is the second
 * click of "an admin who knows only the firm name reaches any of their
 * documents": pick the dealer, see all their deals' documents at once.
 *
 * 404 when the entity id is unknown. A known dealer with no requests yet returns
 * an empty `deals` array — not a 404. Read-only, requireBuybackAdmin, same
 * `{ success, data }` envelope as the sibling reports route.
 */

import { sql } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { requireBuybackAdmin } from "@/lib/buyback/auth";
import { NotFoundError } from "@/lib/buyback/errors";
import { buildDealDocumentSet } from "@/lib/buyback/documents";

export const runtime = "nodejs";

interface DealerRow {
  entity_id: string;
  name: string | null;
}

interface DealRow {
  request_id: string;
  request_no: string;
  status: string;
  deal_id: string;
  /** ISO-8601 UTC string (`to_char … AT TIME ZONE 'UTC'`). */
  created_at: string;
}

export const GET = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ entityId: string }> }) => {
    const { entityId } = await ctx.params;
    await requireBuybackAdmin();

    const dealerRows = (await db.execute(sql`
      SELECT a.id AS entity_id, a.business_entity_name AS name
      FROM accounts a
      WHERE a.id = ${entityId}
    `)) as unknown as DealerRow[];

    const dealer = dealerRows[0];
    if (!dealer) throw new NotFoundError("Dealer not found.");

    // The dealer's requests/deals, newest first
    // (buyback_requests_dealer_created_idx). Bounded by the dealer's own deals.
    const dealRows = (await db.execute(sql`
      SELECT br.id AS request_id, br.request_no, bd.status, bd.id AS deal_id,
             to_char(br.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
      FROM buyback_requests br
      JOIN buyback_deals bd ON bd.request_id = br.id
      WHERE br.dealer_entity_id = ${entityId}
      ORDER BY br.created_at DESC
    `)) as unknown as DealRow[];

    const deals = await Promise.all(
      dealRows.map(async (d) => ({
        request_id: String(d.request_id),
        request_no: String(d.request_no),
        status: String(d.status),
        created_at: String(d.created_at),
        documents: await buildDealDocumentSet(String(d.deal_id)),
      })),
    );

    return successResponse({
      dealer: { entity_id: String(dealer.entity_id), name: dealer.name ?? null },
      deals,
    });
  },
);
