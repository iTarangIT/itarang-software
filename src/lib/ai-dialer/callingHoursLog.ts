// ID 85 (decided 30 Oct): the AI calling hours (assignment_config's working
// hours and days) — saved together with a log row in audit_logs
// (entity_type 'calling_hours': before, after, reason, who, from which
// screen), and read back for the log the CEO sees on Call timing. No
// migration: audit_logs is generic.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { callingHoursChanged, callingHoursReasonError, type CallingHours } from "./callingHoursRules";

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
}): Promise<{ logged: boolean }> {
    return db.transaction(async (tx) => {
        const [cur] = (await tx.execute(sql`
            SELECT config_id::text AS config_id, working_hours_start AS start, working_hours_end AS "end",
                   working_days AS days
              FROM assignment_config ORDER BY created_at ASC LIMIT 1
               FOR UPDATE
        `)) as unknown as Row[];
        const before: CallingHours | null = cur ? { start: cur.start, end: cur.end, days: daysOf(cur.days) } : null;
        const after: CallingHours = { start: input.start, end: input.end, days: input.days ?? null };
        const changed = callingHoursChanged(before, after);
        if (changed) {
            const err = callingHoursReasonError(input.reason);
            if (err) throw new CallingHoursReasonError(err);
        }

        const daysJson = input.days ? JSON.stringify(input.days) : null;
        let configId = cur?.config_id ?? null;
        if (cur) {
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

        if (!changed) return { logged: false };
        const newData: CallingHours = { start: input.start, end: input.end, days: input.days ?? before?.days ?? null };
        await tx.execute(sql`
            INSERT INTO audit_logs (id, entity_type, entity_id, action, performed_by, old_data, new_data, changes)
            VALUES (${`AUDIT-HOURS-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}, ${CALLING_HOURS_ENTITY},
                    ${configId}, 'update', ${input.actorId}::uuid,
                    ${JSON.stringify(before)}::jsonb, ${JSON.stringify(newData)}::jsonb,
                    ${JSON.stringify({ reason: (input.reason ?? "").trim(), source: input.source })}::jsonb)
        `);
        return { logged: true };
    });
}

export type CallingHoursLogRow = {
    at: string;
    before: CallingHours | null;
    after: CallingHours | null;
    reason: string | null;
    source: string | null;
    by: string | null;
};

/** The calling-hours changes, newest first. [] when nothing was logged or the read fails. */
export async function callingHoursLog(limit = 50): Promise<CallingHoursLogRow[]> {
    try {
        const rows = (await db.execute(sql`
            SELECT a.created_at AS at, a.old_data AS before, a.new_data AS after,
                   a.changes->>'reason' AS reason, a.changes->>'source' AS source,
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
        }>;
        return rows.map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
    } catch (err) {
        console.error("[callingHoursLog] read failed:", err instanceof Error ? err.message : err);
        return [];
    }
}
