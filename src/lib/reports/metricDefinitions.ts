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
//   Leads in                 a lead that arrived on its own — NOT a bulk import
//                            (bulkImportedLead below). Bulk imports are counted
//                            apart, so a list upload can't read as 2,000 new
//                            enquiries (decided 7 Oct 2026, after the 28 / 29 Sep
//                            scrape run + INTERAKT list put 2,431 rows into one
//                            week's "Leads in").

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

/** NeoDove leads arriving faster than this per campaign per hour are a list upload. */
export const NEODOVE_BULK_PER_HOUR = 50;

/**
 * The lead came in as part of a bulk import rather than on its own. `dl` is the
 * dealer_leads alias.
 *
 *   - its door is a bulk path: the scraper, the bulk-upload wizard / Import
 *     button, or an AI-dialer list (leadSourceVocab.LEAD_DOORS); or
 *   - it is a NeoDove lead whose "lead created" event arrived with more than
 *     NEODOVE_BULK_PER_HOUR others from the same NeoDove campaign in the same
 *     hour. NeoDove has no import flag, and a list pushed into it (an INTERAKT
 *     broadcast: 1,501 in four minutes on 29 Sep 2026) reaches us as ordinary
 *     LEAD_CREATE webhooks. Genuine arrivals — incoming calls, a rep adding a
 *     dealer — never came close (38 in an hour at most, checked on db-2).
 *
 * The burst groups are found once (uncorrelated), so the predicate stays cheap
 * inside a COUNT over many leads.
 */
export function bulkImportedLead(dl: SQL = sql`dl`): SQL {
    return sql`(
        ${dl}.source_door IN ('scraper', 'bulk_upload', 'ai_dialer')
        OR (
            ${dl}.source_door = 'neodove'
            AND ${dl}.id IN (
                SELECT e.dealer_lead_id
                  FROM neodove_sync_events e
                  JOIN (
                        SELECT g.request_payload ->> 'campaign_id' AS campaign,
                               date_trunc('hour', g.created_at) AS hr
                          FROM neodove_sync_events g
                         WHERE g.direction = 'inbound' AND g.event_type = 'lead_created'
                         GROUP BY 1, 2
                        HAVING COUNT(*) > ${sql.raw(String(NEODOVE_BULK_PER_HOUR))}
                       ) burst
                    ON burst.campaign IS NOT DISTINCT FROM e.request_payload ->> 'campaign_id'
                   AND burst.hr = date_trunc('hour', e.created_at)
                 WHERE e.direction = 'inbound'
                   AND e.event_type = 'lead_created'
                   AND e.dealer_lead_id IS NOT NULL
            )
        )
    )`;
}

/**
 * ID 32 — the agreed rules above, in words, for the AI Analyst (a separate
 * service that writes its own SQL), so the CEO gets one answer to one question.
 * Kept here, beside the SQL it describes: change a rule, change this line.
 * Sent with every question, so it stays short (src/lib/analyst/metricRules.ts).
 */
export const ANALYST_METRIC_RULES = [
    "Days are IST calendar days (yesterday, last month = in IST).",
    "Leads in = active dealer_leads created in the period, EXCLUDING bulk imports (source_door scraper / bulk_upload / ai_dialer, or a NeoDove lead_created burst of more than " +
        `${NEODOVE_BULK_PER_HOUR} per campaign per hour); report bulk imports apart.`,
    "Dealers converted = dealer_leads.lead_status 'Converted' with closed_at in the period.",
    "Calls / dealers called = human calls only: lead_touchpoints.touchpoint_type 'inside_sales_call' (AI dialer 'ai_call' excluded); " +
        `a NeoDove call within ${NEODOVE_CALL_MERGE_WINDOW} of an earlier one by the same agent on the same lead is the same call.`,
    "Engaged call = such a call that connected (call_status 'connected' or is_engaged), any outcome; duration never counts.",
    "Quotes created = the first quote per lead (dealer_lead_commercials quote_issue); revisions counted apart.",
    "Hot handed to field = asm_transfer touchpoints where the lead was Hot at the moment of transfer.",
].join(" ");
