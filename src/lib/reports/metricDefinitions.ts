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
//   Engaged call             connected AND >= N s (30) of MEASURED duration.
//                            By default only NeoDove's recorded duration is a
//                            measurement — one a rep typed is not. NeoDove
//                            sends none today (0 of 2,639 calls on database-2,
//                            01 Oct 2026), so nothing qualifies and every
//                            report shows "Not measured yet" (engagedCallCount
//                            → NULL), never a false 0. The threshold, and
//                            whether typed durations count meanwhile (tracker
//                            question 6, still open), are a SETTING:
//                            app_settings['engaged_call_rule'], edited on the
//                            Sales Daily settings page. These fragments look
//                            it up inline, so a change applies to every report
//                            at once with no deploy; writers store the same
//                            rule in is_engaged (touchpointTypes.isEngagedCall).
//   Hot handed to field      an ASM transfer whose lead was Hot AT THE MOMENT of
//                            transfer (dealer_lead_interest_history, E-304),
//                            not Hot now.
//   Quotes created           the FIRST quote per lead; revisions counted apart.

import { sql, type SQL } from "drizzle-orm";
import {
    ENGAGED_CALL_MIN_SECONDS,
    ENGAGED_CALL_MIN_SECONDS_CEILING,
    ENGAGED_CALL_MIN_SECONDS_FLOOR,
    ENGAGED_CALL_RULE_KEY,
    type EngagedCallRule,
} from "@/lib/lifecycle/touchpointTypes";

export { ENGAGED_CALL_MIN_SECONDS };
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
 * A connected human call, counted once. As with engagedCall(), humanCall()
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

// ── the engaged-call rule, as SQL ───────────────────────────────────────────
// With no `rule` argument a fragment reads app_settings['engaged_call_rule']
// itself (an uncorrelated scalar subquery — evaluated once per statement), with
// the same defaults and bounds normalizeEngagedCallRule() applies. An explicit
// `rule` is for the verifier and tests, to ask "what would the other setting
// show".
const RULE_KEY = sql.raw(`'${ENGAGED_CALL_RULE_KEY}'`);

/** The threshold in seconds. */
export function engagedMinSeconds(rule?: EngagedCallRule): SQL {
    if (rule) return sql`${rule.minSeconds}`;
    return sql`COALESCE((
        -- Nested CASE, not AND: only a CASE guarantees the cast is never
        -- attempted on a value that is not a number.
        SELECT CASE WHEN ecr.value ->> 'min_seconds' ~ '^[0-9]{1,4}$'
                    THEN CASE WHEN (ecr.value ->> 'min_seconds')::int BETWEEN ${sql.raw(String(ENGAGED_CALL_MIN_SECONDS_FLOOR))} AND ${sql.raw(String(ENGAGED_CALL_MIN_SECONDS_CEILING))}
                              THEN (ecr.value ->> 'min_seconds')::int END END
          FROM app_settings ecr WHERE ecr.key = ${RULE_KEY}), ${sql.raw(String(ENGAGED_CALL_MIN_SECONDS))})`;
}

/** TRUE when a duration a rep typed counts as a measurement (question 6 = "reported"). */
function typedDurationsCount(rule?: EngagedCallRule): SQL {
    if (rule) return rule.durationSource === "reported" ? sql`TRUE` : sql`FALSE`;
    return sql`COALESCE((
        SELECT ecr.value ->> 'duration_source' = 'reported'
          FROM app_settings ecr WHERE ecr.key = ${RULE_KEY}), FALSE)`;
}

/**
 * The row carries a duration the rule accepts as a measurement: any
 * NeoDove-recorded one, or — only when the setting says "reported" — one a rep
 * typed. SQL twin of isTimedCall() in touchpointTypes.ts.
 */
export function timedCall(t: SQL = sql`t`, rule?: EngagedCallRule): SQL {
    return sql`${t}.call_duration_sec IS NOT NULL AND (${t}.external_system = 'neodove' OR ${typedDurationsCount(rule)})`;
}

/** An inside-sales call whose duration was measured — the denominator of "can engaged be reported at all". */
export function measuredCall(t: SQL = sql`t`, rule?: EngagedCallRule): SQL {
    return sql`${t}.touchpoint_type = 'inside_sales_call' AND ${timedCall(t, rule)}`;
}

/**
 * An engaged human call: connected and at least the threshold of MEASURED
 * duration (timedCall).
 *
 * humanCall() keeps the EARLIEST row of a NeoDove call, but the connect and
 * the duration can arrive on a later re-disposition of that same call — so the
 * kept row also counts as engaged when a later twin (same lead, same
 * performer, within the merge window) qualifies. Still at most one per call,
 * so engaged <= calls always holds.
 */
export function engagedCall(t: SQL = sql`t`, rule?: EngagedCallRule): SQL {
    return sql`${humanCall(t)}
        AND (
            (${t}.call_status = 'connected'
             AND ${timedCall(t, rule)}
             AND COALESCE(${t}.call_duration_sec, 0) >= ${engagedMinSeconds(rule)})
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
                       AND COALESCE(twin.call_duration_sec, 0) >= ${engagedMinSeconds(rule)}
                )
            )
        )`;
}

/**
 * Engaged calls as an AGGREGATE over rows aliased `t`: NULL — "Not measured
 * yet" — when no call in the set has a measured duration, else the count. A
 * bare COUNT would print 0 for a team whose every call came through NeoDove
 * with no duration, which reads as "nobody had a real conversation".
 */
export function engagedCallCount(t: SQL = sql`t`, rule?: EngagedCallRule): SQL {
    return sql`CASE WHEN COUNT(*) FILTER (WHERE ${measuredCall(t, rule)}) = 0 THEN NULL
                    ELSE COUNT(*) FILTER (WHERE ${engagedCall(t, rule)}) END`;
}

/**
 * Was THIS touchpoint an engaged one — TRUE / FALSE / NULL (not measurable).
 * For the per-row "Engaged" column and for "the lead had an engaged
 * touchpoint". A call follows the rule, whatever its stored is_engaged says
 * (rows written before 01 Oct 2026 carry "any connected call"): not connected
 * → FALSE; connected with a measured duration → at least the threshold;
 * connected with none → NULL. Every other type keeps its stored flag (a
 * productive visit, a WhatsApp reply, a rep's own tick).
 */
export function engagedState(t: SQL = sql`t`, rule?: EngagedCallRule): SQL {
    return sql`(CASE
        WHEN ${t}.touchpoint_type <> 'inside_sales_call' THEN ${t}.is_engaged
        WHEN ${t}.call_status IS DISTINCT FROM 'connected' THEN FALSE
        WHEN ${timedCall(t, rule)} THEN ${t}.call_duration_sec >= ${engagedMinSeconds(rule)}
        ELSE NULL
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
