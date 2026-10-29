/**
 * Tracker ID 199 — the review columns a manager reads on a team view of the
 * ASM queue, the Inside Sales queue and their downloads: last action (what +
 * when), next follow-up, last visit (date + outcome), working days since the
 * last action. "Time limit passed" is the existing past_limits decoration
 * (queuePastLimit.ts). Server only (the working-day SQL reads holiday_calendar).
 *
 * Every caller must have `dl` (dealer_leads) in scope and join
 * LAST_DONE_VISIT_JOIN.
 */
import { sql } from "drizzle-orm";
import { workingDaysSinceSql } from "@/lib/calendar/holidays";

/**
 * The last visit that actually happened. Not LATEST_VISIT_JOIN: that one picks
 * the newest row by COALESCE(actual, scheduled, created), so a visit booked
 * for next week would hide the one made yesterday.
 */
export const LAST_DONE_VISIT_JOIN = sql`
    LEFT JOIN LATERAL (
        SELECT actual_visit_date, visit_outcome
        FROM lead_visits
        WHERE dealer_lead_id = dl.id AND actual_visit_date IS NOT NULL
        ORDER BY actual_visit_date DESC, created_at DESC
        LIMIT 1
    ) ldv ON true
`;

/**
 * Select-list fragment (leading comma included) for the review columns.
 * dl.next_follow_up_at is selected by each builder itself (the ISR one
 * already had it), so it is not repeated here.
 */
export const TEAM_REVIEW_SELECT = sql`,
            dl.last_disposition AS last_action,
            dl.last_worked_at::text AS last_action_at,
            ldv.actual_visit_date::text AS last_visit_date,
            ldv.visit_outcome AS last_visit_outcome,
            CASE WHEN dl.last_worked_at IS NULL THEN NULL
                 ELSE ${workingDaysSinceSql(sql`dl.last_worked_at`)} END AS days_since_action`;

/** The fields TEAM_REVIEW_SELECT adds to a row. */
export type TeamReviewFields = {
    last_action?: string | null;
    last_action_at?: string | null;
    next_follow_up_at?: string | null;
    last_visit_date?: string | null;
    last_visit_outcome?: string | null;
    days_since_action?: number | null;
};
