// The metric definitions agreed 26 Sep 2026 (tracker ID 59, handover P0-4 /
// P0-5). ONE place, used by the sales dashboard, targets and the daily email,
// so the three can never disagree about what a call or a quote is.
//
//   Dealers called / calls   HUMAN calls only: inside_sales_call. AI dialer
//                            calls (ai_call) are not a rep's effort.
//   One call, one count      NeoDove sends a dispose event per disposition, and
//                            agents re-disposition within seconds (P0-5, checked
//                            on database-1 2026-09-29: 16% of NeoDove call
//                            touchpoints had a twin within 3 minutes). A NeoDove
//                            call touchpoint with an earlier one on the same lead
//                            within NEODOVE_CALL_MERGE_WINDOW is the same call.
//   Engaged call             a connected human call where the rep spoke with
//                            the dealer — through NeoDove or logged by the
//                            rep, any outcome (decided 3 Oct 2026). Duration
//                            never counts and neither does temperature; there
//                            is no setting. Writers store the same rule in
//                            is_engaged (touchpointTypes.isEngagedCall).
//   Hot handed to field      an ASM transfer whose lead was Hot AT THE MOMENT of
//                            transfer (dealer_lead_interest_history, E-304),
//                            not Hot now.
//   Quotes created           the FIRST quote per lead; revisions counted apart.
//   Leads in                 EVERY new active dealer lead, whatever brought it in:
//                            a rep, inbound, referral, bulk upload, the scraper,
//                            an AI-dialer list, NeoDove (ID 153, Kartik 10 Oct —
//                            reverses the 7 Oct rule that left bulk imports out).
//                            Door and Origin still split it by source.

import { sql, type SQL } from "drizzle-orm";
export const NEODOVE_CALL_MERGE_WINDOW = "3 minutes";

/**
 * A human call, counted once. `t` is the lead_touchpoints alias.
 * The NOT EXISTS drops a NeoDove re-disposition of a call already counted.
 */
export function humanCall(t: SQL = sql`t`): SQL {
    return sql`${t}.touchpoint_type = 'inside_sales_call'
        AND NOT (
            ${t}.external_system = 'neodove'
            AND EXISTS (
                SELECT 1 FROM lead_touchpoints prev
                 WHERE prev.dealer_lead_id = ${t}.dealer_lead_id
                   AND prev.touchpoint_type = 'inside_sales_call'
                   AND prev.external_system = 'neodove'
                   AND prev.touchpoint_id <> ${t}.touchpoint_id
                   AND prev.performed_by IS NOT DISTINCT FROM ${t}.performed_by
                   AND prev.performed_at <= ${t}.performed_at
                   AND prev.performed_at >= ${t}.performed_at - ${sql.raw(`INTERVAL '${NEODOVE_CALL_MERGE_WINDOW}'`)}
                   AND (prev.performed_at < ${t}.performed_at OR prev.touchpoint_id < ${t}.touchpoint_id)
            )
        )`;
}

/**
 * A connected human call, counted once. humanCall()
 * keeps the EARLIEST row of a NeoDove call and the connect can sit on a later
 * re-disposition of it — so the kept row is connected when it, or a later twin
 * within the merge window, is. Counting `call_status = 'connected'` rows
 * directly counts a re-dispositioned call twice.
 */
export function connectedCall(t: SQL = sql`t`): SQL {
    return sql`${humanCall(t)}
        AND (
            ${t}.call_status = 'connected'
            OR (
                ${t}.external_system = 'neodove'
                AND EXISTS (
                    SELECT 1 FROM lead_touchpoints twin
                     WHERE twin.dealer_lead_id = ${t}.dealer_lead_id
                       AND twin.touchpoint_type = 'inside_sales_call'
                       AND twin.external_system = 'neodove'
                       AND twin.touchpoint_id <> ${t}.touchpoint_id
                       AND twin.performed_by IS NOT DISTINCT FROM ${t}.performed_by
                       AND twin.performed_at >= ${t}.performed_at
                       AND twin.performed_at <= ${t}.performed_at + ${sql.raw(`INTERVAL '${NEODOVE_CALL_MERGE_WINDOW}'`)}
                       AND twin.call_status = 'connected'
                )
            )
        )`;
}

/**
 * An engaged human call (ID 59, decided 3 Oct 2026): a connected human call,
 * counted once — the rep spoke with the dealer. No duration and no temperature
 * condition, so it is connectedCall() under the name every report uses.
 */
export function engagedCall(t: SQL = sql`t`): SQL {
    return connectedCall(t);
}

/**
 * Was THIS touchpoint an engaged one — TRUE / FALSE. For the per-row "Engaged"
 * column and for "the lead had an engaged touchpoint". A call follows the
 * rule, whatever its stored is_engaged says (rows written 1–5 Oct 2026 carry
 * the retired duration rule): engaged exactly when it connected. Every other
 * type keeps its stored flag (a productive visit, a WhatsApp reply, a rep's
 * own tick).
 */
export function engagedState(t: SQL = sql`t`): SQL {
    return sql`(CASE
        WHEN ${t}.touchpoint_type <> 'inside_sales_call' THEN ${t}.is_engaged
        ELSE ${t}.call_status IS NOT DISTINCT FROM 'connected'
    END)`;
}

/**
 * The lead was Hot at the instant `at`: the rating set by the latest change at
 * or before it; else the rating the first LATER change moved away from; else,
 * with no history at all (E-304 has no backfill), the current rating.
 */
export function wasHotAt(leadId: SQL, at: SQL, currentLevel: SQL): SQL {
    return sql`lower(CASE
        WHEN EXISTS (SELECT 1 FROM dealer_lead_interest_history h
                      WHERE h.dealer_lead_id = ${leadId} AND h.changed_at <= ${at})
        THEN (SELECT h.to_level FROM dealer_lead_interest_history h
               WHERE h.dealer_lead_id = ${leadId} AND h.changed_at <= ${at}
               ORDER BY h.changed_at DESC LIMIT 1)
        WHEN EXISTS (SELECT 1 FROM dealer_lead_interest_history h
                      WHERE h.dealer_lead_id = ${leadId})
        THEN (SELECT h.from_level FROM dealer_lead_interest_history h
               WHERE h.dealer_lead_id = ${leadId} AND h.changed_at > ${at}
               ORDER BY h.changed_at ASC LIMIT 1)
        ELSE ${currentLevel}
    END) = 'hot'`;
}

/** The first quote row of its lead (quote_issue / quote_revision, lowest version). `c` = dealer_lead_commercials alias. */
export function isFirstQuote(c: SQL = sql`c`): SQL {
    return sql`NOT EXISTS (
        SELECT 1 FROM dealer_lead_commercials earlier
         WHERE earlier.dealer_lead_id = ${c}.dealer_lead_id
           AND earlier.event_type IN ('quote_issue', 'quote_revision')
           AND earlier.version_no < ${c}.version_no
    )`;
}

/**
 * ID 32 — the agreed rules above, in words, for the AI Analyst (a separate
 * service that writes its own SQL), so the CEO gets one answer to one question.
 * Kept here, beside the SQL it describes: change a rule, change this line.
 * Sent with every question, so it stays short (src/lib/analyst/metricRules.ts).
 */
export const ANALYST_METRIC_RULES = [
    "Days, yesterday and months are IST calendar days.",
    "Leads in = every active dealer_leads row created in the period, whatever its source (bulk imports included).",
    "Dealers converted = dealer_leads.lead_status 'Converted' with closed_at in the period, credited to closing_owner_id.",
    "Calls / dealers called = human calls only: lead_touchpoints.touchpoint_type 'inside_sales_call' (AI dialer 'ai_call' excluded); " +
        `a NeoDove call within ${NEODOVE_CALL_MERGE_WINDOW} of an earlier one by the same agent on the same lead is the same call.`,
    "Engaged call = such a call that connected (call_status 'connected' or is_engaged), any outcome; duration never counts.",
    "Quotes created = the first quote per lead (dealer_lead_commercials quote_issue); revisions counted apart.",
    "Hot handed to field = asm_transfer touchpoints where the lead was Hot when transferred, each dealer once.",
    // ID 169 (10 Oct): Undo Mark Won leaves the history row; won_undone_at marks it.
    "Marked Won = status history to_status 'Won' with won_undone_at NULL, credited to closing_owner_id.",
    "A Lost to Lost history row is a reason change, not a loss.",
    "Visits = lead_visits visit_status 'visited'.",
    // ID 11 — Finance was folded into Battery sale (E-331).
    "business_type 'finance' means battery_sale.",
].join(" ");
