/**
 * 23 Nov — a file waiting for the iTarang House dealer check is NOT shown to
 * the dealer it was proposed for. The dealer sees it only once iTarang House
 * (or a dealer-check person by their link) approves the dealer.
 *
 * Hidden: leads.assignment_status = 'pending_verification' (check open) or
 * 'dealer_rejected' (house rejected this dealer — the file is not theirs).
 *
 * Not hidden: a file the dealer's OWN sales team created (reason_kind
 * 'dealer_salesperson') — the dealer's people made it, so the dealer keeps it.
 * The iTarang House login is not affected (it sees what it pushed out through
 * houseOriginatedLeadIds, a separate path).
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { leadDealerReviews, leads } from "@/lib/db/schema";

import { DEALER_CHECK_HOLD_STATUSES } from "./dealer-assignment-rules";

/**
 * WHERE fragment for dealer-facing lead lists: true when the dealer may see the
 * row. Use as `and(eq(leads.dealer_id, code), visibleToDealerSql())`.
 */
export function visibleToDealerSql(): SQL {
  return sql`(
    ${leads.assignment_status} IS NULL
    OR ${leads.assignment_status} NOT IN (${sql.join(
      DEALER_CHECK_HOLD_STATUSES.map((s) => sql`${s}`),
      sql`, `,
    )})
    OR EXISTS (
      SELECT 1 FROM lead_dealer_reviews r
      WHERE r.lead_id = ${leads.id}
        AND r.reason_kind = 'dealer_salesperson'
        AND r.status IN ('pending', 'rejected')
    )
  )`;
}

/** Is this one lead hidden from its dealer by an open / rejected dealer check? */
export async function isHiddenFromDealer(leadId: string): Promise<boolean> {
  try {
    const [l] = await db
      .select({ status: leads.assignment_status })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!l?.status || !(DEALER_CHECK_HOLD_STATUSES as readonly string[]).includes(l.status)) return false;
    const [own] = await db
      .select({ id: leadDealerReviews.id })
      .from(leadDealerReviews)
      .where(
        and(
          eq(leadDealerReviews.lead_id, leadId),
          eq(leadDealerReviews.reason_kind, "dealer_salesperson"),
          inArray(leadDealerReviews.status, ["pending", "rejected"]),
        ),
      )
      .limit(1);
    return !own;
  } catch (err) {
    // A database without E-390: no dealer check, nothing hidden.
    console.warn("[dealer-check-visibility] lookup failed", err instanceof Error ? err.message : String(err));
    return false;
  }
}
