/**
 * How long was this call, and did it connect?
 *
 * ONE RULE, TWO LANGUAGES. Every screen that shows a call duration has to agree
 * with every other one, and until now they did not: `deriveDuration` lived
 * inline in the campaign leads route, a byte-identical twin lived in the
 * transcript route, and two more SQL copies of the same CASE expression summed
 * talk time in the campaign list routes. Four copies of one business rule is
 * four chances for the histogram to disagree with the table sitting directly
 * below it. This module is the rule; the copies get deleted as they are touched.
 *
 * THE RULE
 *   Provider-reported `ai_call_logs.call_duration` when it is finite and > 0,
 *   else the wall clock `dialer_campaign_leads.completed_at - started_at`, kept
 *   only when it lands inside a sane window, else UNKNOWN.
 *
 *   The clamp matters. A campaign lead that was marked calling and never
 *   finalised can carry a `started_at` from last Tuesday, and subtracting that
 *   from a `completed_at` written by a later sweep yields a "call" of nine
 *   hours. Anything at or beyond DURATION_MAX_SECONDS is not a long call, it is
 *   a bookkeeping artefact, and it is dropped rather than bucketed.
 *
 * UNKNOWN IS NULL, NOT ZERO. The SQL twin yields NULL where the older summing
 * copies yield 0, because a histogram must be able to tell "this call lasted no
 * time" from "we were never told how long this call lasted". Sum sites get the
 * old behaviour back by wrapping: sum(coalesce(<expr>, 0)).
 *
 * CONNECTED := a transcript exists OR a derived duration exists and is > 0.
 *   Deliberately WIDER than AI_CONNECTED_PREDICATE in ./exclusionFilter, which
 *   tests the transcript alone. That predicate answers "may we dial this dealer
 *   again", where a false positive costs a wasted call, so it is strict. This
 *   one answers "did talking happen, and for how long", where a call with real
 *   talk time but no stored transcript is still a call that happened and still
 *   belongs in the distribution. The two are allowed to differ; they are not
 *   allowed to differ silently, which is why this comment exists.
 *
 * PURE — no `@/lib/db` import. Importing `sql` from drizzle-orm is not a
 * database connection, the same trick ./exclusionFilter uses so its guard tests
 * need no mocks.
 */
import { sql, type SQL } from "drizzle-orm";

/**
 * Longest wall-clock span still treated as a real call, in seconds.
 *
 * 2 hours, matching the clamp the leads route has always applied. No AI call in
 * production has ever passed three minutes, so this is a sanity bound on broken
 * timestamps rather than a business limit on call length.
 */
export const DURATION_MAX_SECONDS = 7200;

/**
 * Duration of one call in whole seconds, or null when we do not know.
 *
 * `callDuration` is typed loosely because drizzle hands back `integer` columns
 * as a number but a correlated subquery's value can arrive as a string; both
 * shapes reach this function in practice.
 */
export function deriveDurationSeconds(
    callDuration: number | string | null | undefined,
    startedAt: Date | string | null | undefined,
    completedAt: Date | string | null | undefined,
): number | null {
    const provided = callDuration != null ? Number(callDuration) : null;
    if (provided != null && Number.isFinite(provided) && provided > 0) {
        return Math.round(provided);
    }

    if (startedAt && completedAt) {
        const diffSec = Math.round(
            (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000,
        );
        if (diffSec > 0 && diffSec < DURATION_MAX_SECONDS) return diffSec;
    }

    return null;
}

/**
 * Did this call connect?
 *
 * See the header: a transcript is proof, and so is measurable talk time. A call
 * with neither produced no conversation, whatever its status column claims.
 */
export function isCallConnected(input: {
    hasTranscript: boolean | null | undefined;
    durationSeconds: number | null | undefined;
}): boolean {
    if (input.hasTranscript) return true;
    return input.durationSeconds != null && input.durationSeconds > 0;
}

/**
 * SQL twin of deriveDurationSeconds. Yields NULL when unknown.
 *
 * ALIAS CONTRACT — the caller MUST alias `dialer_campaign_leads` as `dcl` and
 * the ai_call_logs row as `acl`. Same convention as the existing copies in
 * unified/route.ts and ai-dialer/campaigns/route.ts, and the same
 * required-alias pattern as AI_CONNECTED_PREDICATE ("dealer_leads MUST be
 * aliased `dl`"). The aliases are fixed rather than parameterised on purpose:
 * an alias argument would mean sql.raw() on caller input, which is an injection
 * surface bought for nothing.
 */
export const DURATION_SECONDS_PREDICATE =
    "CASE" +
    " WHEN acl.call_duration IS NOT NULL AND acl.call_duration > 0" +
    " THEN acl.call_duration" +
    " WHEN dcl.started_at IS NOT NULL AND dcl.completed_at IS NOT NULL" +
    " AND extract(epoch FROM (dcl.completed_at - dcl.started_at)) > 0" +
    ` AND extract(epoch FROM (dcl.completed_at - dcl.started_at)) < ${DURATION_MAX_SECONDS}` +
    " THEN extract(epoch FROM (dcl.completed_at - dcl.started_at))::int" +
    " ELSE NULL" +
    " END";

/** The same expression as a drizzle fragment. Safe: no caller input reaches it. */
export const DURATION_SECONDS_SQL: SQL = sql.raw(DURATION_SECONDS_PREDICATE);

/** CONNECTED, in SQL. Same alias contract as DURATION_SECONDS_PREDICATE. */
export const CONNECTED_PREDICATE =
    `(acl.transcript IS NOT NULL OR (${DURATION_SECONDS_PREDICATE}) > 0)`;

export const CONNECTED_SQL: SQL = sql.raw(CONNECTED_PREDICATE);

/**
 * The same duration rule as a self-contained scalar subquery, for callers that
 * cannot provide the `dcl` / `acl` aliases.
 *
 * The campaign leads route selects from dialer_campaign_leads without joining
 * ai_call_logs — it reaches the log through correlated subqueries — so
 * DURATION_SECONDS_SQL has no aliases to bind to there. Rather than write a
 * second copy of the CASE with the subquery inlined (which is how the four
 * existing copies of this rule came to exist), this wraps the ONE predicate in
 * a derived table that supplies both aliases. The expression is identical by
 * construction, so a durationBucket filter and the histogram can never disagree
 * about which bucket a call belongs to.
 *
 * Costs one correlated subquery per row, the same shape the route already pays
 * four times over for transcript/status/call_status.
 */
export function correlatedDurationSeconds(
    startedAt: unknown,
    completedAt: unknown,
    bolnaCallId: unknown,
): SQL {
    return sql`(
        SELECT ${DURATION_SECONDS_SQL}
          FROM (SELECT ${startedAt} AS started_at, ${completedAt} AS completed_at) dcl
          LEFT JOIN LATERAL (
            SELECT a.call_duration
              FROM ai_call_logs a
             WHERE a.call_id = ${bolnaCallId}
             ORDER BY a.updated_at DESC NULLS LAST
             LIMIT 1
          ) acl ON TRUE
    )`;
}
