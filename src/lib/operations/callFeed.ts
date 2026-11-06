/**
 * Tracker ID 229 (found 3 Nov) — are calls still reaching live?
 *
 * NeoDove's webhook was pointed at the sandbox for weeks and nothing said so:
 * the CRM simply showed fewer calls. This measures, in WORKING minutes (office
 * hours on working days, holidays skipped), how long since the last
 *   - NeoDove delivery reached this server (neodove_sync_events, inbound,
 *     parseable — our own clock, not NeoDove's call time), and
 *     6 Nov: the NeoDove alarm counts only while leads are WAITING — an ISR
 *     or ASM pushed a lead to NeoDove (outbound push_lead, 2xx) and no update
 *     has come back since. The gap runs from the oldest such push; with no
 *     push waiting it is 0, so a day with no pushes never rings.
 *   - AI dialer result was written (ai_call_logs.ended_at, any provider).
 * The ops collector alarms past 2 working hours (registry: calls.feed_gap);
 * the Sales Daily email prints the same two lines each morning.
 *
 * "Now" is Postgres now(), read in the same statement — never the app clock
 * (scheduler clock skew).
 */
import { sql } from "drizzle-orm";
import { bgDb as db } from "@/lib/db/background";
import { loadOfficeCalendar } from "@/lib/calendar/holidays";
import { workingMinutesBetween } from "@/lib/leads/workingHours";

import type { CallFeedKey } from "./callFeedText";
export { CALL_FEED_ALARM_WORKING_MINUTES, CALL_FEED_LABEL, type CallFeedKey } from "./callFeedText";

export type CallFeedStatus = {
    feed: CallFeedKey;
    /** ISO; null = nothing ever received on this database. */
    lastAt: string | null;
    /**
     * When the wait started: NeoDove = the oldest successful push with no
     * update since (null = nothing waiting); AI dialer = lastAt.
     */
    waitingSince: string | null;
    /**
     * Working minutes since waitingSince. NeoDove: 0 when nothing is waiting;
     * null only when the NeoDove tables do not exist. AI dialer: null when
     * nothing was ever received.
     */
    gapWorkingMinutes: number | null;
};

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

export async function loadCallFeedStatus(): Promise<{ now: string; feeds: CallFeedStatus[] }> {
    const [r] = rowsOf<{
        now: string;
        has_neodove: boolean;
        neodove: string | null;
        neodove_waiting: string | null;
        ai_dialer: string | null;
    }>(
        await db.execute(sql`
            WITH last_in AS (
                SELECT CASE WHEN to_regclass('public.neodove_sync_events') IS NULL THEN NULL ELSE
                    (SELECT MAX(created_at) FROM neodove_sync_events
                      WHERE direction = 'inbound' AND event_type IS DISTINCT FROM 'unparseable') END AS at
            )
            SELECT now()::text AS now,
                   to_regclass('public.neodove_sync_events') IS NOT NULL AS has_neodove,
                   (SELECT at::text FROM last_in) AS neodove,
                   (CASE WHEN to_regclass('public.neodove_sync_events') IS NULL THEN NULL ELSE
                       (SELECT MIN(created_at)::text FROM neodove_sync_events
                         WHERE direction = 'outbound' AND event_type = 'push_lead'
                           AND http_status BETWEEN 200 AND 299
                           AND created_at > COALESCE((SELECT at FROM last_in), '-infinity'::timestamptz)) END) AS neodove_waiting,
                   (SELECT MAX(ended_at)::text FROM ai_call_logs WHERE ended_at IS NOT NULL) AS ai_dialer
        `),
    );
    const now = r?.now ?? new Date().toISOString();
    const { holidays, hours } = await loadOfficeCalendar();
    const gap = (last: string | null): number | null =>
        last ? workingMinutesBetween(new Date(last), new Date(now), holidays, hours) : null;
    return {
        now,
        feeds: [
            {
                feed: "neodove" as const,
                lastAt: r?.neodove ?? null,
                waitingSince: r?.neodove_waiting ?? null,
                gapWorkingMinutes: !r?.has_neodove ? null : r.neodove_waiting ? gap(r.neodove_waiting) : 0,
            },
            {
                feed: "ai_dialer" as const,
                lastAt: r?.ai_dialer ?? null,
                waitingSince: r?.ai_dialer ?? null,
                gapWorkingMinutes: gap(r?.ai_dialer ?? null),
            },
        ],
    };
}

export { istWhen, workingGapText } from "./callFeedText";
