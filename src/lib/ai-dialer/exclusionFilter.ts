// BRD §0.2 — the AI-dialer exclusion filter.
//
// A phone is "AI-dialable" only when:
//   - it has never entered the Part-0 sales lifecycle (lead_status IS NULL)
//     and is not on the permanent do-not-call list (ai_recall_status =
//     'excluded', set on a business_closed Lost), OR
//   - it is a Lost lead an admin explicitly pushed back to the dialer
//     (lead_status = 'Lost' AND ai_recall_status = 'awaiting_re_dial').
//
// Anything in an active sales state (Assigned_Not_Contacted … Transferred_to_ASM,
// Converted) must NOT be called — the dialer must never re-contact a dealer
// that Inside Sales or an ASM is actively working.
//
// NOTE (no-regression): dealer_leads.lead_status is written ONLY by Part-0
// routes (claim / mark-* / touchpoint status change / bulk upload). Every
// pre-Part-0 scraped lead has lead_status = NULL, so it stays dialable. This
// filter only ever NARROWS the AI pool — it can never widen it.

import { and, eq, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { dealerLeads } from "@/lib/db/schema";

// Raw SQL predicate for hand-written queries. The dealer_leads table MUST be
// aliased `dl` at the call site.
export const AI_DIALABLE_SQL = sql.raw(
    "(" +
        "(dl.lead_status IS NULL AND " +
        "(dl.ai_recall_status IS NULL OR dl.ai_recall_status <> 'excluded'))" +
        " OR " +
        "(dl.lead_status = 'Lost' AND dl.ai_recall_status = 'awaiting_re_dial')" +
        ")",
);

// Drizzle condition for query-builder call sites (cron, campaign advance).
export function aiDialableCondition(): SQL {
    return or(
        and(
            isNull(dealerLeads.lead_status),
            or(
                isNull(dealerLeads.ai_recall_status),
                ne(dealerLeads.ai_recall_status, "excluded"),
            ),
        ),
        and(
            eq(dealerLeads.lead_status, "Lost"),
            eq(dealerLeads.ai_recall_status, "awaiting_re_dial"),
        ),
    ) as SQL;
}

// In-memory predicate for rows already fetched — e.g. a defensive re-check
// mid-campaign, where the lead's state may have changed since it was queued.
export function isAiDialable(row: {
    lead_status?: string | null;
    ai_recall_status?: string | null;
}): boolean {
    const status = row.lead_status ?? null;
    const recall = row.ai_recall_status ?? null;
    if (status === null) return recall !== "excluded";
    return status === "Lost" && recall === "awaiting_re_dial";
}
