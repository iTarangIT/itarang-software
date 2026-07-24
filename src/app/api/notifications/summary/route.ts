/**
 * GET /api/notifications/summary
 *
 * Unread counts for the CRM-wide bell, broken down by category so the
 * notifications page can badge its filter chips ("KYC & Consent (3)").
 *
 * Returns `{ unread: { total, byCategory } }`.
 *
 * SCOPE IS THE SAME TWO-HALF RECIPIENT SCOPE the feed uses — user_id, plus the
 * pre-hub dealer rows that carry only dealer_id. Duplicated here as SQL rather
 * than imported because this route counts with a GROUP BY in raw SQL; if you
 * change one, change the other (src/app/api/notifications/route.ts).
 *
 * "unread" means unread AND active — not archived, not deleted — matching the
 * badge the feed returns. `read IS NOT TRUE` rather than `= false`, because the
 * column is nullable and `= false` silently skips NULLs.
 */

import { sql } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";
import { db } from "@/lib/db";
import { CATEGORIES, categorize, type NotificationCategory } from "@/lib/notifications/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async () => {
  const user = await requireAuth();
  const dealerId = user.dealer_id ?? null;

  const rows = (await db.execute(sql`
    SELECT type, count(*)::int AS n
      FROM notifications
     WHERE (
             user_id = ${user.id}
             OR (${dealerId}::text IS NOT NULL AND user_id IS NULL AND dealer_id = ${dealerId})
           )
       AND read IS NOT TRUE
       AND deleted_at IS NULL
       AND archived_at IS NULL
     GROUP BY type
  `)) as unknown as Array<{ type: string; n: number }>;

  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<
    NotificationCategory,
    number
  >;
  let total = 0;
  for (const row of rows) {
    const n = Number(row.n);
    byCategory[categorize(String(row.type))] += n;
    total += n;
  }

  return successResponse({ unread: { total, byCategory } });
});
