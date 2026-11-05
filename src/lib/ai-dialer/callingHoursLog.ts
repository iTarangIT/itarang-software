// ID 85 (decided 30 Oct): the AI calling hours (assignment_config's working
// hours and days) — saved together with a log row in audit_logs
// (entity_type 'calling_hours': before, after, reason, who, from which
// screen), and read back for the log the CEO sees on Call timing. No
// migration: audit_logs is generic.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
    callingHoursChanged,
    callingHoursReasonError,
    dueScheduledHours,
    effectiveFromError,
    type CallingHours,
    type ScheduledHours,
} from "./callingHoursRules";

/** Today in IST, YYYY-MM-DD. */
export function istDay(now: Date = new Date()): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

export const CALLING_HOURS_ENTITY = "calling_hours";

export class CallingHoursReasonError extends Error {
    readonly status = 400;
}

type Row = { config_id: string; start: string | null; end: string | null; days: unknown };

const daysOf = (v: unknown): string[] | null => (Array.isArray(v) ? v.map(String) : null);

/**
 * Save the calling hours (and, when given, the days and the AI intent
 * threshold) on the one assignment_config row, creating it if missing. When
 * the hours or days change, a reason is required and a log row is written in
 * the same transaction. Throws CallingHoursReasonError for a missing reason.
 */
export async function saveCallingHours(input: {
    start: string;
    end: string;
    days?: string[] | null;
    intentScoreThreshold?: number | null;
    reason?: string | null;
    actorId: string;
    source: "call_timing" | "assignment_config";
    /**
     * ID 85: the IST day the new hours start (YYYY-MM-DD). Absent or today =
     * at once. A later day only records the change; resolveScheduleDefaults
     * applies it on that day (applyDueCallingHours).
     */
    effectiveFrom?: string | null;
}): Promise<{ logged: boolean; scheduled: boolean }> {
    const today = istDay();
    const dayErr = effectiveFromError(input.effectiveFrom, today);
    if (dayErr) throw new CallingHoursReasonError(dayErr);
    const from = input.effectiveFrom && input.effectiveFrom > today ? input.effectiveFrom : today;
    const scheduled = from > today;
    return db.transaction(async (tx) => {
        const [cur] = (await tx.execute(sql`
            SELECT config_id::text AS config_id, working_hours_start AS start, working_hours_end AS "end",
                   working_days AS days
              FROM assignment_config ORDER BY created_at ASC LIMIT 1
               FOR UPDATE
        `)) as unknown as Row[];
        const before: CallingHours | null = cur ? { start: cur.start, end: cur.end, days: daysOf(cur.days) } : null;
        const after: CallingHours = { start: input.start, end: input.end, days: input.days ?? null };
        // A dated change is always a change to record, even if it repeats today's hours.
        const changed = scheduled || callingHoursChanged(before, after);
        if (changed) {
            const err = callingHoursReasonError(input.reason);
            if (err) throw new CallingHoursReasonError(err);
        }

        const daysJson = input.days ? JSON.stringify(input.days) : null;
        let configId = cur?.config_id ?? null;
        if (cur && scheduled) {
            // Later day: the hours stay; only the AI threshold (not dated) is saved now.
            await tx.execute(sql`
                UPDATE assignment_config
                   SET intent_score_threshold = COALESCE(${input.intentScoreThreshold ?? null}::int, intent_score_threshold),
                       updated_by = ${input.actorId}, updated_at = now()
                 WHERE config_id = ${cur.config_id}::uuid
            `);
        } else if (cur) {
            await tx.execute(sql`
                UPDATE assignment_config
                   SET working_hours_start = ${input.start}, working_hours_end = ${input.end},
                       working_days = COALESCE(${daysJson}::jsonb, working_days),
                       intent_score_threshold = COALESCE(${input.intentScoreThreshold ?? null}::int, intent_score_threshold),
                       updated_by = ${input.actorId}, updated_at = now()
                 WHERE config_id = ${cur.config_id}::uuid
            `);
        } else {
            const [row] = (await tx.execute(sql`
                INSERT INTO assignment_config (working_hours_start, working_hours_end, working_days, intent_score_threshold, updated_by)
                VALUES (${input.start}, ${input.end},
                        COALESCE(${daysJson}::jsonb, '["mon","tue","wed","thu","fri","sat"]'::jsonb),
                        COALESCE(${input.intentScoreThreshold ?? null}::int, 60), ${input.actorId})
                RETURNING config_id::text AS config_id
            `)) as unknown as Array<{ config_id: string }>;
            configId = row?.config_id ?? null;
        }

        if (!changed) return { logged: false, scheduled: false };
        const newData: CallingHours = { start: input.start, end: input.end, days: input.days ?? before?.days ?? null };
        await tx.execute(sql`
            INSERT INTO audit_logs (id, entity_type, entity_id, action, performed_by, old_data, new_data, changes)
            VALUES (${`AUDIT-HOURS-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}, ${CALLING_HOURS_ENTITY},
                    ${configId}, 'update', ${input.actorId}::uuid,
                    ${JSON.stringify(before)}::jsonb, ${JSON.stringify(newData)}::jsonb,
                    ${JSON.stringify({
                        reason: (input.reason ?? "").trim(),
                        source: input.source,
                        effective_from: from,
                        scheduled,
                        // Applied at once when it starts today; a dated one when its day comes.
                        applied_at: scheduled ? null : new Date().toISOString(),
                    })}::jsonb)
        `);
        dueCheckedAt = 0;
        return { logged: true, scheduled };
    });
}

let dueCheckedAt = 0;
const DUE_CHECK_MS = 60_000;

/**
 * ID 85: put a dated calling-hours change into force once its day has come —
 * write it to assignment_config and mark it applied. Called from
 * resolveScheduleDefaults (every reader of the hours), at most once a minute
 * per process; the row lock makes two processes apply it once. Never throws.
 */
export async function applyDueCallingHours(now: Date = new Date()): Promise<boolean> {
    if (Date.now() - dueCheckedAt < DUE_CHECK_MS) return false;
    dueCheckedAt = Date.now();
    const today = istDay(now);
    try {
        return await db.transaction(async (tx) => {
            const pending = (await tx.execute(sql`
                SELECT id, changes->>'effective_from' AS effective_from, created_at::text AS created_at, new_data
                  FROM audit_logs
                 WHERE entity_type = ${CALLING_HOURS_ENTITY}
                   AND (changes->>'scheduled')::boolean IS TRUE
                   AND changes->>'applied_at' IS NULL
                   AND changes->>'effective_from' <= ${today}
                 FOR UPDATE SKIP LOCKED
            `)) as unknown as Array<{ id: string; effective_from: string; created_at: string; new_data: CallingHours }>;
            const rows: ScheduledHours[] = pending.map((r) => ({
                id: r.id,
                effectiveFrom: r.effective_from,
                createdAt: r.created_at,
                hours: r.new_data,
            }));
            const due = dueScheduledHours(rows, today);
            if (!due) return false;
            const h = due.hours;
            const daysJson = h.days && h.days.length ? JSON.stringify(h.days) : null;
            await tx.execute(sql`
                UPDATE assignment_config
                   SET working_hours_start = COALESCE(${h.start}, working_hours_start),
                       working_hours_end = COALESCE(${h.end}, working_hours_end),
                       working_days = COALESCE(${daysJson}::jsonb, working_days),
                       updated_at = now()
                 WHERE config_id = (SELECT config_id FROM assignment_config ORDER BY created_at ASC LIMIT 1)
            `);
            // Every due row is now settled: the latest is in force, older ones were overtaken.
            const ids = rows.map((r) => r.id);
            await tx.execute(sql`
                UPDATE audit_logs
                   SET changes = changes || jsonb_build_object('applied_at', ${new Date().toISOString()}::text)
                 WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
            `);
            return true;
        });
    } catch (err) {
        console.error("[callingHours] applying a dated change failed:", err instanceof Error ? err.message : err);
        return false;
    }
}

export type CallingHoursLogRow = {
    at: string;
    before: CallingHours | null;
    after: CallingHours | null;
    reason: string | null;
    source: string | null;
    by: string | null;
    /** ID 85: the day the hours start (older rows: the day they were changed). */
    effective_from: string | null;
    /** True while a dated change waits for its day. */
    pending: boolean;
};

/** The calling-hours changes, newest first. [] when nothing was logged or the read fails. */
export async function callingHoursLog(limit = 50): Promise<CallingHoursLogRow[]> {
    try {
        const rows = (await db.execute(sql`
            SELECT a.created_at AS at, a.old_data AS before, a.new_data AS after,
                   a.changes->>'reason' AS reason, a.changes->>'source' AS source,
                   COALESCE(a.changes->>'effective_from', ((a.created_at AT TIME ZONE 'Asia/Kolkata')::date)::text) AS effective_from,
                   ((a.changes->>'scheduled')::boolean IS TRUE AND a.changes->>'applied_at' IS NULL) AS pending,
                   COALESCE(u.name, u.email) AS by
              FROM audit_logs a
              LEFT JOIN users u ON u.id = a.performed_by
             WHERE a.entity_type = ${CALLING_HOURS_ENTITY}
             ORDER BY a.created_at DESC
             LIMIT ${limit}
        `)) as unknown as Array<{
            at: string | Date;
            before: CallingHours | null;
            after: CallingHours | null;
            reason: string | null;
            source: string | null;
            by: string | null;
            effective_from: string | null;
            pending: boolean;
        }>;
        return rows.map((r) => ({ ...r, pending: r.pending === true, at: new Date(r.at).toISOString() }));
    } catch (err) {
        console.error("[callingHoursLog] read failed:", err instanceof Error ? err.message : err);
        return [];
    }
}
