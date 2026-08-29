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
 *   A DURATION IS A PROPERTY OF A CONVERSATION. A call that never connected has
 *   no duration — not a zero, and not the wall-clock time the dialer spent
 *   failing to place it.
 *
 *   CONNECTED := a transcript exists, OR the provider reported talk time > 0.
 *   DURATION  := the provider's `ai_call_logs.call_duration` when it is finite
 *                and > 0; else, ONLY for a call a transcript proves connected,
 *                the wall clock `dialer_campaign_leads.completed_at -
 *                started_at` when it lands inside a sane window; else UNKNOWN.
 *
 * WHY THE WALL CLOCK IS GATED (the bug this shape exists to prevent)
 *   `started_at` and `completed_at` on the campaign-lead row bracket the
 *   DIALER'S ATTEMPT, not a conversation. A `trigger_failed` lead — the
 *   provider rejected the trigger outright, no phone ever rang — still carries
 *   both timestamps, five to sixty seconds apart. Read as a duration, that
 *   bookkeeping latency became a real-looking call: a production campaign of
 *   146 leads (71 completed, 75 failed) reported all 146 as "measured calls",
 *   scattering never-placed calls across the <20s, 20-40s and 40-60s bars and
 *   inflating the median, the average and total talk time along with them.
 *   Measured across every campaign, the wall clock overshoots real talk time by
 *   an average of 93 seconds on failed rows and 40 on completed ones.
 *
 *   So the wall clock is a MEASUREMENT of a call already known to have
 *   connected, never EVIDENCE that it did. `isCallConnected` cannot even see it.
 *
 *   The clamp still matters on top of that gate. A campaign lead that was marked
 *   calling and never finalised can carry a `started_at` from last Tuesday, and
 *   subtracting that from a `completed_at` written by a later sweep yields a
 *   "call" of nine hours. Anything at or beyond DURATION_MAX_SECONDS is not a
 *   long call, it is a bookkeeping artefact, and it is dropped rather than
 *   bucketed.
 *
 * UNKNOWN IS NULL, NOT ZERO. The SQL twin yields NULL where the older summing
 * copies yield 0, because a histogram must be able to tell "this call lasted no
 * time" from "we were never told how long this call lasted". Sum sites get the
 * old behaviour back by wrapping: sum(coalesce(<expr>, 0)).
 *
 * CONNECTED here is deliberately WIDER than AI_CONNECTED_PREDICATE in
 * ./exclusionFilter, which tests the transcript alone. That predicate answers
 * "may we dial this dealer again", where a false positive costs a wasted call,
 * so it is strict. This one answers "did talking happen, and for how long",
 * where a call with real provider-reported talk time but no stored transcript is
 * still a call that happened and still belongs in the distribution. The two are
 * allowed to differ; they are not allowed to differ silently, which is why this
 * comment exists.
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
 * The provider's own talk time, or null when it told us nothing usable.
 *
 * Typed loosely because drizzle hands back an `integer` column as a number but
 * a correlated subquery's value can arrive as a string; both shapes reach this
 * in practice. This is the ONLY numeric evidence that a call connected, so
 * every caller that needs to ask "did this connect" goes through here rather
 * than comparing a derived duration against zero.
 */
function providerTalkSeconds(
    callDuration: number | string | null | undefined,
): number | null {
    if (callDuration == null) return null;
    const n = typeof callDuration === "number" ? callDuration : Number(callDuration);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n);
}

/**
 * Duration of one call in whole seconds, or null when we do not know.
 *
 * `hasTranscript` is REQUIRED rather than optional on purpose. It is the gate
 * that keeps dialer latency out of the wall-clock arm, and an optional
 * parameter defaulting to false would let an un-updated call site silently keep
 * the old behaviour instead of failing to compile.
 */
export function deriveDurationSeconds(
    callDuration: number | string | null | undefined,
    startedAt: Date | string | null | undefined,
    completedAt: Date | string | null | undefined,
    hasTranscript: boolean | null | undefined,
): number | null {
    const provided = providerTalkSeconds(callDuration);
    if (provided != null) return provided;

    // No provider talk time. The wall clock is only a duration if something
    // else already proves a conversation happened — see the header.
    if (!hasTranscript) return null;

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
 * See the header: a transcript is proof, and so is provider-reported talk time.
 * A call with neither produced no conversation, whatever its status column
 * claims and however long the dialer spent on it.
 *
 * Takes the PROVIDER's value, not a derived duration. Passing a derived
 * duration here is what let wall-clock latency masquerade as talk time, so the
 * parameter is named to make the wrong argument obvious at the call site.
 */
export function isCallConnected(input: {
    hasTranscript: boolean | null | undefined;
    providerDurationSeconds: number | string | null | undefined;
}): boolean {
    if (input.hasTranscript) return true;
    return providerTalkSeconds(input.providerDurationSeconds) != null;
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
 *
 * `acl.transcript IS NOT NULL` guards the wall-clock arm, mirroring the
 * `hasTranscript` parameter of the TypeScript twin. Drop it and every
 * trigger_failed row is bucketed by how long the dialer took to fail.
 */
export const DURATION_SECONDS_PREDICATE =
    "CASE" +
    " WHEN acl.call_duration IS NOT NULL AND acl.call_duration > 0" +
    " THEN acl.call_duration" +
    " WHEN acl.transcript IS NOT NULL" +
    " AND dcl.started_at IS NOT NULL AND dcl.completed_at IS NOT NULL" +
    " AND extract(epoch FROM (dcl.completed_at - dcl.started_at)) > 0" +
    ` AND extract(epoch FROM (dcl.completed_at - dcl.started_at)) < ${DURATION_MAX_SECONDS}` +
    " THEN extract(epoch FROM (dcl.completed_at - dcl.started_at))::int" +
    " ELSE NULL" +
    " END";

/** The same expression as a drizzle fragment. Safe: no caller input reaches it. */
export const DURATION_SECONDS_SQL: SQL = sql.raw(DURATION_SECONDS_PREDICATE);

/**
 * CONNECTED, in SQL. Same alias contract as DURATION_SECONDS_PREDICATE.
 *
 * Reads `acl` only. The absence of `dcl` here is the point: this predicate
 * decides whether a conversation happened, and the campaign-lead timestamps
 * have nothing to say about that.
 */
export const CONNECTED_PREDICATE =
    "(acl.transcript IS NOT NULL" +
    " OR (acl.call_duration IS NOT NULL AND acl.call_duration > 0))";

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
 * The LATERAL selects `transcript` as well as `call_duration` because the
 * predicate now reads both. Selecting the column, not its text, keeps the
 * transfer cost at one boolean-shaped comparison inside Postgres.
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
            SELECT a.call_duration, a.transcript
              FROM ai_call_logs a
             WHERE a.call_id = ${bolnaCallId}
             ORDER BY a.updated_at DESC NULLS LAST
             LIMIT 1
          ) acl ON TRUE
    )`;
}
