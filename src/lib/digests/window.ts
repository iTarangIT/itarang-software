/**
 * The IST day window, in SQL (E-288).
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

/**
 * An inclusive IST date RANGE ("YYYY-MM-DD" … "YYYY-MM-DD") for a NAIVE UTC
 * wall-clock column — the multi-day sibling of `istDayWindowNaive`, for report
 * screens with a from/to picker. Either bound may be null (open-ended); both
 * null is always true.
 */
export function istRangeNaive(column: Col, fromDay: string | null, toDay: string | null) {
  const parts = [sql`TRUE`];
  if (fromDay) {
    parts.push(
      sql`(${column} AT TIME ZONE 'UTC') >= (${fromDay}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`,
    );
  }
  if (toDay) {
    parts.push(
      sql`(${column} AT TIME ZONE 'UTC') < ((${toDay}::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')`,
    );
  }
  return sql.join(parts, sql` AND `);
}

/** `istRangeNaive` for a `timestamptz` column. */
export function istRangeTz(column: Col, fromDay: string | null, toDay: string | null) {
  const parts = [sql`TRUE`];
  if (fromDay) {
    parts.push(sql`${column} >= (${fromDay}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`);
  }
  if (toDay) {
    parts.push(
      sql`${column} < ((${toDay}::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')`,
    );
  }
  return sql.join(parts, sql` AND `);
}

/** A "YYYY-MM-DD" query param, or null when absent/malformed. */
export function parseIsoDay(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}
