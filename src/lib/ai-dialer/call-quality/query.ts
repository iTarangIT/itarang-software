/**
 * The one query behind the call-quality funnel.
 *
 * ONE ROW PER LEAD, and the LATERAL is what guarantees it. `ai_call_logs`'s
 * call_id index is NOT unique, so a plain LEFT JOIN multiplies a lead by however
 * many log rows share its call_id — which would inflate every stage of the
 * funnel and, worse, inflate them unevenly. The same trap the duration histogram
 * documents at length; the same fix.
 *
 * TRANSCRIPTS ARE THE EXPENSIVE COLUMN, so they are fetched only for rows that
 * could possibly have one: the join already restricts to this campaign, and a
 * lead with no bolna_call_id joins to nothing. Across the whole database 83 of
 * 407 leads have a transcript, averaging under 1.5KB, so this is well under the
 * threshold where streaming or a two-phase fetch would earn its complexity.
 * Revisit alongside the parse-on-read decision at ~50k rows (see funnel.ts).
 *
 * No JS Date crosses the boundary — nothing here is time-filtered, and the
 * duration comes from the provider's own integer column.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import type { CallQualityRow } from "./funnel";

/**
 * Does this database have E-267's `transcript_turns` column?
 *
 * ASKED, NOT ASSUMED, and that is the whole point. E-267 is deliberately
 * skippable — the column is absent from schema.ts precisely so an unapplied
 * migration cannot break the AI call-logging pipeline — which means the
 * application genuinely does not know whether it exists. Naming it
 * unconditionally in this SELECT would make an unapplied E-267 fail the entire
 * call-quality panel with SQLSTATE 42703, reintroducing on the READ side the
 * exact hazard the write side was restructured to avoid.
 *
 * Memoised for the life of the process. A column does not appear mid-request,
 * and this is on the path of a panel that refetches every ten seconds on a live
 * campaign. A deploy restarts the process, so applying E-267 takes effect
 * without any cache-busting; the worst case is that the timings stay dark until
 * the next restart, which is also when the code that writes them arrives.
 */
let transcriptTurnsColumn: Promise<boolean> | null = null;

export function hasTranscriptTurnsColumn(): Promise<boolean> {
    if (!transcriptTurnsColumn) {
        transcriptTurnsColumn = db
            .execute(sql`
                SELECT 1
                  FROM information_schema.columns
                 WHERE table_name = 'ai_call_logs'
                   AND column_name = 'transcript_turns'
                 LIMIT 1`)
            .then((rows) => Array.from(rows as Iterable<unknown>).length > 0)
            // A failed probe must not take the panel down with it. Assume the
            // column is absent: the cost is one dark metric, where the cost of
            // assuming present is the whole query failing.
            .catch(() => false);
    }
    return transcriptTurnsColumn;
}

/** Test seam — resets the memo so a suite can drive both branches. */
export function __resetTranscriptTurnsProbe(): void {
    transcriptTurnsColumn = null;
}

/**
 * Every lead of one campaign, joined to its ONE authoritative log row.
 *
 * Column aliases are the camelCase field names of CallQualityRow so the result
 * needs no reshaping — the fold consumes driver output directly, and a renamed
 * field fails at the type boundary rather than silently arriving undefined.
 */
export function buildCallQualitySql(
    campaignId: string,
    opts: { withTurns?: boolean } = {},
): SQL {
    // Two literal fragments rather than one interpolated column name. Neither
    // is caller-controlled, so nothing reaches the statement that a boolean
    // did not choose.
    const turnsSelect = opts.withTurns
        ? sql`, acl.transcript_turns AS "transcriptTurns"`
        : sql``;
    const turnsInner = opts.withTurns ? sql`, a.transcript_turns` : sql``;

    return sql`
    SELECT dcl.status,
           dcl.call_outcome       AS "callOutcome",
           acl.call_duration      AS "providerDurationSeconds",
           acl.transcript,
           acl.info_signals_count AS "infoSignalsCount"${turnsSelect}
      FROM dialer_campaign_leads dcl
      LEFT JOIN LATERAL (
        SELECT a.call_duration, a.transcript, a.info_signals_count${turnsInner}
          FROM ai_call_logs a
         WHERE a.call_id = dcl.bolna_call_id
         ORDER BY a.updated_at DESC NULLS LAST
         LIMIT 1
      ) acl ON TRUE
     WHERE dcl.campaign_id = ${campaignId}`;
}

/** Driver rows are untyped at the boundary; assert once, here. */
export function asCallQualityRows(rows: unknown): CallQualityRow[] {
    return Array.from(rows as Iterable<unknown>) as CallQualityRow[];
}
