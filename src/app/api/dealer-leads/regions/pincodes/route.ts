/**
 * GET /api/dealer-leads/regions/pincodes?state=X&city=Y
 *
 * Pincode drill-down for the region selector — optional third level
 * after state and city. Returns distinct, non-empty pincodes for the
 * requested state + city, with lead counts. Empty list when the city
 * has no pincoded leads (older rows that pre-date the address parser
 * are common here).
 */

import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { withErrorHandler, successResponse, errorResponse } from "@/lib/api-utils";
import { and, eq, isNotNull, ne, sql, desc } from "drizzle-orm";

export const GET = withErrorHandler(async (req: Request) => {
  const url = new URL(req.url);
  const state = url.searchParams.get("state")?.trim();
  const city = url.searchParams.get("city")?.trim();

  if (!state || !city) {
    return errorResponse("state and city query params are required", 400);
  }

  const rows = await db
    .select({
      pincode: dealerLeads.pincode,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(dealerLeads)
    .where(
      and(
        eq(dealerLeads.state, state),
        eq(dealerLeads.city, city),
        isNotNull(dealerLeads.pincode),
        ne(dealerLeads.pincode, ""),
        isNotNull(dealerLeads.phone),
        ne(dealerLeads.phone, ""),
      ),
    )
    .groupBy(dealerLeads.pincode)
    .orderBy(desc(sql`COUNT(*)`));

  return successResponse(rows);
});
