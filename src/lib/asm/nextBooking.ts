// ID 247 — "Next visit" is the lead's ONE open booking, everywhere: Data downloads, My visits
// and the lead page. Before this the download took the earliest booking dated today or
// later, so a booking whose day had passed (never logged) vanished: in Jiten's 174 leads,
// 52 showed the wrong next visit and 48 overdue visits were hidden.
//
// The one open booking = the NEWEST open row (status scheduled / pending_scheduling) by
// when it was booked; the clean-up script keeps the same one (scripts/cleanup-stale-bookings.ts).
// A booking whose date has passed is still the next visit: it is overdue, by N days.

import { sql, type SQL } from "drizzle-orm";

/** Visit statuses that are still a booking (not done, not called off). */
export const OPEN_BOOKING_STATUSES = ["scheduled", "pending_scheduling"] as const;

/**
 * LATERAL join giving `<alias>.visit_id`, `<alias>.scheduled_date` (may be null for a
 * booking not yet dated) and `<alias>.overdue_days` (> 0 only when the date has passed,
 * IST) for the lead aliased `dl`.
 */
export function nextBookingJoin(alias = "nb", lead: SQL = sql`dl.id`): SQL {
    const a = sql.raw(alias);
    return sql`LEFT JOIN LATERAL (
        SELECT b.visit_id, b.scheduled_date,
               CASE WHEN b.scheduled_date < (now() AT TIME ZONE 'Asia/Kolkata')::date
                    THEN ((now() AT TIME ZONE 'Asia/Kolkata')::date - b.scheduled_date)::int END AS overdue_days
          FROM lead_visits b
         WHERE b.dealer_lead_id = ${lead}
           AND b.visit_status IN ('scheduled', 'pending_scheduling')
         ORDER BY b.created_at DESC, b.scheduled_date DESC NULLS LAST
         LIMIT 1
    ) ${a} ON TRUE`;
}

/** Days between a booking date and today (IST), > 0 only when the date has passed. Pure (for the screens and tests). */
export function overdueDays(scheduledDate: string | null | undefined, todayIst: string): number | null {
    if (!scheduledDate) return null;
    const d = Date.parse(`${scheduledDate.slice(0, 10)}T00:00:00Z`);
    const t = Date.parse(`${todayIst}T00:00:00Z`);
    if (Number.isNaN(d) || Number.isNaN(t) || d >= t) return null;
    return Math.round((t - d) / 86_400_000);
}

/**
 * ID 224 item 2: the touchpoints that count as a "latest remark": written by a person, a
 * NeoDove call or an AI call. Not the system's re-inquiry, sales-ready, record-correction,
 * assignment or lead-created lines.
 */
export const REMARK_TOUCHPOINT_TYPES = [
    "inside_sales_call",
    "ai_call",
    "whatsapp",
    "visit",
    "status_change_note",
    "escalation_raised",
    "escalation_ceo_comment",
    "escalation_ceo_recommendation",
    "onboarding_dropout_action",
] as const;
