// Admin → Dealer Verification: which applications are listed and which are
// still waiting for admin action. Shared by the page's summary cards
// (/api/admin/dealer-verifications/summary) and the menu count (ID 90).

import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db/index";

/** The status the page shows: a decision wins, then the review step, else the form's own state. Alias `a`. */
export const DEALER_APP_DERIVED_STATUS: SQL = sql`CASE
            WHEN a.onboarding_status IN ('approved', 'rejected', 'correction_requested')
              THEN a.onboarding_status
            WHEN a.review_status IS NOT NULL AND a.review_status <> 'draft'
              THEN a.review_status
            ELSE a.onboarding_status
          END`;

/** Applications the page lists. ID 169: a form withdrawn by Undo Mark Won was never submitted. Alias `a`. */
export const DEALER_APP_LISTED: SQL = sql`(a.onboarding_status <> 'draft' OR a.submitted_at IS NOT NULL) AND NOT (a.onboarding_status = 'withdrawn' AND a.submitted_at IS NULL)`;

/** Derived statuses still waiting for admin action (the "Pending review" card). */
export const DEALER_APP_PENDING_STATUSES: SQL = sql`('submitted', 'pending_admin_review', 'pending_sales_head',
                             'under_review', 'agreement_in_progress')`;

/** ID 90 — the "Pending review" card with no date range: what waits right now. */
export async function countDealerValidationPending(): Promise<number> {
    const rows = (await db.execute(sql`
        SELECT COUNT(*)::int AS n
          FROM dealer_onboarding_applications a
         WHERE ${DEALER_APP_LISTED}
           AND (${DEALER_APP_DERIVED_STATUS}) IN ${DEALER_APP_PENDING_STATUSES}
    `)) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
}
