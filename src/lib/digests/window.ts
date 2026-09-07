/**
 * The IST day window, in SQL (E-286).
 *
 * Two helpers, because this codebase has two kinds of timestamp column and using
 * the wrong helper is a silent 5h30m error in both directions.
 *
 * The half-open `>= start … < start + 1 day` shape is lifted from
 * src/lib/campaigns/cost-analytics-query.ts, which documents the same skew.
 */

import { sql } from "drizzle-orm";

type Col = ReturnType<typeof sql>;

/**
 * For a `timestamptz` column — the normal case, and everything in the KYC
 * neighbourhood (`admin_verification_queue`, `kyc_verifications`, `audit_logs`,
 * `admin_kyc_reviews`, `other_document_requests`).
 *
 * Postgres knows the instant, so it only has to be told which day boundaries to
 * compare against.
 */
export function istDayWindowTz(column: Col, istDay: string) {
  return sql`${column} >= (${istDay}::date::timestamp AT TIME ZONE 'Asia/Kolkata')
         AND ${column} <  ((${istDay}::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')`;
}

/**
 * For a NAIVE `timestamp` column holding UTC wall-clock — the dealer-onboarding
 * neighbourhood (`dealer_onboarding_applications`, `dealer_correction_rounds`).
 *
 * The app writes `new Date()` into a `timestamp without time zone` while the
 * session TimeZone is UTC, so what is stored is UTC wall-clock with no offset
 * attached. `AT TIME ZONE 'UTC'` is what turns it back into an instant. Without
 * the lift, a bare `approved_at::date = '…'` buckets everything that happened
 * between 00:00 and 05:29 IST — a full Indian working morning — into the
 * PREVIOUS day.
 */
export function istDayWindowNaive(column: Col, istDay: string) {
  return sql`(${column} AT TIME ZONE 'UTC') >= (${istDay}::date::timestamp AT TIME ZONE 'Asia/Kolkata')
         AND (${column} AT TIME ZONE 'UTC') <  ((${istDay}::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')`;
}
