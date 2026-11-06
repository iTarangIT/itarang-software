/**
 * Tracker ID 229 (found 3 Nov) — are calls still reaching live?
 *
 * NeoDove's webhook was pointed at the sandbox for weeks and nothing said so:
 * the CRM simply showed fewer calls. This measures, in WORKING minutes (office
 * hours on working days, holidays skipped), how long since the last
 *   - NeoDove delivery reached this server (neodove_sync_events, inbound,
 *     parseable — our own clock, not NeoDove's call time), and
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
    /** Working minutes since lastAt; null when lastAt is null. */
    gapWorkingMinutes: number | null;
};

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

export async function loadCallFeedStatus(): Promise<{ now: string; feeds: CallFeedStatus[] }> {
    const [r] = rowsOf<{ now: string; neodove: string | null; ai_dialer: string | null }>(
        await db.execute(sql`
            SELECT now()::text AS now,
                   (CASE WHEN to_regclass('public.neodove_sync_events') IS NULL THEN NULL ELSE
                       (SELECT MAX(created_at)::text FROM neodove_sync_events
                         WHERE direction = 'inbound' AND event_type IS DISTINCT FROM 'unparseable') END) AS neodove,
                   (SELECT MAX(ended_at)::text FROM ai_call_logs WHERE ended_at IS NOT NULL) AS ai_dialer
        `),
    );
    const now = r?.now ?? new Date().toISOString();
    const { holidays, hours } = await loadOfficeCalendar();
    const gap = (last: string | null): number | null =>
        last ? workingMinutesBetween(new Date(last), new Date(now), holidays, hours) : null;
    return {
        now,
        feeds: (["neodove", "ai_dialer"] as const).map((feed) => ({
            feed,
            lastAt: r?.[feed] ?? null,
            gapWorkingMinutes: gap(r?.[feed] ?? null),
        })),
    };
}

export { istWhen, workingGapText } from "./callFeedText";
