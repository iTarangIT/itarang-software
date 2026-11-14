// IDs 245 / 237 — WHEN a visit happened, in one rule for every reader.
//
// A visit row has a date (actual_visit_date) and, since E-363, the verified shop photo's
// time (captured_at, raw-SQL column, read through to_jsonb so a database without E-363
// still works). Before this the time-limit clocks read every visit as 10:00 am IST, so a
// rep who visited at 3:27 pm a lead that arrived at 3:24 pm was charged a miss, and the
// Sales Head pop-ups showed 10:00 am or midnight.
//
//   1. the photo time (captured_at);
//   2. else the time the visit was logged (created_at), when that is the same IST day;
//   3. else 10:00 IST on the visit day (office opening): the old rule, kept as a fallback.
// `visitHasTimeSql` says whether 1 or 2 applied, so a screen can write "no time recorded".

import { sql, type SQL } from "drizzle-orm";

/** The visit's timestamptz under the rule above, for the lead_visits alias `v`. */
export function visitTimeSql(alias = "v"): SQL {
    const v = sql.raw(alias);
    return sql`COALESCE(
        (to_jsonb(${v}) ->> 'captured_at')::timestamptz,
        CASE WHEN ${v}.actual_visit_date IS NOT NULL
              AND (${v}.created_at AT TIME ZONE 'Asia/Kolkata')::date = ${v}.actual_visit_date
             THEN ${v}.created_at END,
        (${v}.actual_visit_date + TIME '10:00') AT TIME ZONE 'Asia/Kolkata'
    )`;
}

/** True when the visit has a real time (photo, or logged the same day); false = date only. */
export function visitHasTimeSql(alias = "v"): SQL {
    const v = sql.raw(alias);
    return sql`(
        (to_jsonb(${v}) ->> 'captured_at') IS NOT NULL
        OR (${v}.actual_visit_date IS NOT NULL
            AND (${v}.created_at AT TIME ZONE 'Asia/Kolkata')::date = ${v}.actual_visit_date)
    )`;
}

/** Pure twin of visitTimeSql for tests and client code. Times are ISO strings. */
export function visitTime(v: { captured_at?: string | null; created_at?: string | null; actual_visit_date?: string | null }): {
    at: string | null;
    hasTime: boolean;
} {
    if (v.captured_at) return { at: new Date(v.captured_at).toISOString(), hasTime: true };
    const day = v.actual_visit_date?.slice(0, 10) ?? null;
    if (day && v.created_at) {
        const createdIst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(v.created_at));
        if (createdIst === day) return { at: new Date(v.created_at).toISOString(), hasTime: true };
    }
    if (day) return { at: new Date(`${day}T10:00:00+05:30`).toISOString(), hasTime: false };
    return { at: null, hasTime: false };
}

/**
 * ID 237 (Sales Head pop-ups and their CSV): the photo time as an ISO instant
 * ("2026-11-03T09:57:00Z"), else the visit DATE alone ("2026-11-03"), which the screens
 * show with "no time recorded". Never 10:00 am or midnight standing in for a time.
 */
export function visitWhenTextSql(alias = "v"): SQL {
    const v = sql.raw(alias);
    return sql`COALESCE(
        to_char((to_jsonb(${v}) ->> 'captured_at')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        ${v}.actual_visit_date::text
    )`;
}
