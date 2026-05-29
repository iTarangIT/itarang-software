/**
 * GET /api/dealer-leads/locations
 *
 * Returns the distinct, trimmed locations present on dialable dealer_leads
 * (rows with a non-empty phone) along with their counts. Used by the
 * "Start AI Dialer" modal's location dropdown so the user can scope an
 * outbound session to a region.
 *
 * The trim collapses "Nashik" / "Nashik " / "Nashik\t" into one bucket.
 * Sorting by count first (descending) keeps the most-populated regions at
 * the top so the user lands on a useful default quickly.
 */

import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { withErrorHandler, successResponse } from "@/lib/api-utils";
import { and, isNotNull, ne, sql, desc, asc } from "drizzle-orm";

export const GET = withErrorHandler(async () => {
    const trimmedLocation = sql<string>`TRIM(${dealerLeads.location})`;

    const rows = await db
        .select({
            location: trimmedLocation,
            count: sql<number>`COUNT(*)::int`,
        })
        .from(dealerLeads)
        .where(
            and(
                isNotNull(dealerLeads.location),
                ne(trimmedLocation, ""),
                isNotNull(dealerLeads.phone),
                ne(dealerLeads.phone, ""),
            ),
        )
        .groupBy(trimmedLocation)
        .orderBy(desc(sql`COUNT(*)`), asc(trimmedLocation));

    return successResponse(rows);
});
