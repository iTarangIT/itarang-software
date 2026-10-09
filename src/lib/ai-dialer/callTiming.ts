// ID 144 — AI dialer dials, answers and conversations by weekday × hour (IST).
//
// EVERY ATTEMPT, not just the last. dialer_campaign_leads keeps only the latest
// attempt's status and call id on the row; each attempt is appended to
// attempt_history (campaignTracker.recordAttemptOutcome). So the attempts come
// from unpacking that array, and a row from before attempt_history existed
// falls back to the row itself.
//
// WHEN = the dial. ai_call_logs.created_at is the moment the call was placed;
// the history entry's `at` (when the outcome was recorded) is only the fallback
// for an attempt whose call log is missing.
//
// Outcome buckets are the E-300 / E-310 campaign statuses
// (src/lib/ai-dialer/campaignLeadStatus.ts):
//   dials    — every attempt that went out (`failed` = never left our side, and
//              is not a dealer's behaviour, so it is left out)
//   answered — picked up: completed, silent, hung_up, no_conversation
//   talked   — the dealer spoke: completed

import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { buildCallTimingGrid, type CallTimingGrid, type CallTimingRow } from "./callTimingShape";

export interface CallTimingFilters {
    /** IST calendar days, inclusive, "YYYY-MM-DD". */
    from: string | null;
    to: string | null;
    campaignId: string | null;
    state: string | null;
    city: string | null;
}

const DIALLED = ["completed", "no_response", "busy", "rejected", "voicemail", "silent", "hung_up", "no_conversation"];
const ANSWERED = ["completed", "silent", "hung_up", "no_conversation"];

const list = (values: string[]): SQL => sql.join(values.map((v) => sql`${v}`), sql`, `);

/** One row per attempt: status, when it was dialled, and the lead's place. */
function attemptsSql(f: CallTimingFilters): SQL {
    const where: SQL[] = [sql`a.status IN (${list(DIALLED)})`, sql`a.dialled_at IS NOT NULL`];
    if (f.from) where.push(sql`a.dialled_at >= (${f.from}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`);
    if (f.to) where.push(sql`a.dialled_at < ((${f.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`);
    if (f.state) where.push(sql`lower(btrim(dl.state)) = lower(btrim(${f.state}))`);
    if (f.city) where.push(sql`lower(btrim(dl.city)) = lower(btrim(${f.city}))`);

    const campaign = f.campaignId ? sql`AND dcl.campaign_id = ${f.campaignId}` : sql``;
    return sql`
        WITH att AS (
            SELECT dcl.lead_id, h ->> 'status' AS status, NULLIF(h ->> 'call_id', '') AS call_id,
                   (h ->> 'at')::timestamptz AS recorded_at
              FROM dialer_campaign_leads dcl
             CROSS JOIN LATERAL jsonb_array_elements(dcl.attempt_history) h
             WHERE jsonb_typeof(dcl.attempt_history) = 'array' ${campaign}
            UNION ALL
            -- Rows from before attempt_history: the row is its one attempt.
            SELECT dcl.lead_id, dcl.status, dcl.bolna_call_id, COALESCE(dcl.started_at, dcl.completed_at)
              FROM dialer_campaign_leads dcl
             WHERE (jsonb_typeof(dcl.attempt_history) IS DISTINCT FROM 'array'
                    OR jsonb_array_length(dcl.attempt_history) = 0) ${campaign}
        )
        SELECT a.status, a.dialled_at
          FROM (
            SELECT att.lead_id, att.status, COALESCE(acl.created_at, att.recorded_at) AS dialled_at
              FROM att
              LEFT JOIN ai_call_logs acl ON acl.call_id = att.call_id
          ) a
          LEFT JOIN dealer_leads dl ON dl.id = a.lead_id
         WHERE ${sql.join(where, sql` AND `)}`;
}

export async function getCallTimingGrid(f: CallTimingFilters): Promise<CallTimingGrid> {
    const rows = (await db.execute(sql`
        SELECT EXTRACT(ISODOW FROM t.dialled_at AT TIME ZONE 'Asia/Kolkata')::int AS dow,
               EXTRACT(HOUR   FROM t.dialled_at AT TIME ZONE 'Asia/Kolkata')::int AS hour,
               COUNT(*)::int                                                       AS dials,
               COUNT(*) FILTER (WHERE t.status IN (${list(ANSWERED)}))::int        AS answered,
               COUNT(*) FILTER (WHERE t.status = 'completed')::int                 AS talked
          FROM (${attemptsSql(f)}) t
         GROUP BY 1, 2
    `)) as unknown as CallTimingRow[];
    return buildCallTimingGrid(rows);
}

/** States and cities that have AI dialer attempts — for the filter pickers. */
export async function getCallTimingPlaces(): Promise<Array<{ state: string; city: string | null }>> {
    return (await db.execute(sql`
        SELECT DISTINCT initcap(btrim(dl.state)) AS state, initcap(btrim(dl.city)) AS city
          FROM dialer_campaign_leads dcl
          JOIN dealer_leads dl ON dl.id = dcl.lead_id
         WHERE NULLIF(btrim(dl.state), '') IS NOT NULL
         ORDER BY 1, 2
    `)) as unknown as Array<{ state: string; city: string | null }>;
}

/**
 * ID 144 — "use the data to set calling hours": the hours new campaigns are
 * pre-filled with (resolveScheduleDefaults reads assignment_config's first row,
 * and nothing else reads these two columns). Days are left as they are.
 */
export async function setDefaultCallingHours(windowStart: string, windowEnd: string, userId: string): Promise<void> {
    const updated = (await db.execute(sql`
        UPDATE assignment_config
           SET working_hours_start = ${windowStart}, working_hours_end = ${windowEnd},
               updated_by = ${userId}, updated_at = now()
         WHERE config_id = (SELECT config_id FROM assignment_config ORDER BY created_at ASC LIMIT 1)
        RETURNING config_id
    `)) as unknown as unknown[];
    if (updated.length === 0) {
        await db.execute(sql`
            INSERT INTO assignment_config (working_hours_start, working_hours_end, updated_by)
            VALUES (${windowStart}, ${windowEnd}, ${userId})
        `);
    }
}

/** Who may change the default calling hours — the same roles as the settings page. */
export const CALLING_HOURS_EDIT_ROLES = ["admin", "sales_head"] as const;
