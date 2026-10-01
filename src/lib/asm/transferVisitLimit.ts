/**
 * Tracker ID 77.1 — "Awaiting field visit" (Transferred_to_ASM) has a limit:
 * the ASM's first visit is due within N working days (Mon–Sat) of the transfer.
 * N is admin-set, stored in app_settings['asm_transfer_visit_limit_days'] as
 * { days, updated_by } (same shape as the Quotation CC list), default 3.
 *
 * Overdue = the lead is STILL Transferred_to_ASM, more than N working days have
 * passed since its latest move into Transferred_to_ASM (lead_status_history;
 * assigned_at for a lead with no history row), and no visit has been marked
 * visited since. Read by the admin alert panel and the needs-attention list —
 * the SQL lives here so the two cannot disagree.
 */
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";

export const ASM_TRANSFER_VISIT_LIMIT_KEY = "asm_transfer_visit_limit_days";
export const ASM_TRANSFER_VISIT_LIMIT_DEFAULT = 3;
export const ASM_TRANSFER_VISIT_LIMIT_MAX = 30;

/** The limit as a SQL int scalar; a missing / bad row reads as the default. */
export const TRANSFER_VISIT_LIMIT_SQL: SQL = sql.raw(`COALESCE((
    SELECT CASE WHEN (s.value->>'days') ~ '^[0-9]+$' THEN (s.value->>'days')::int END
      FROM app_settings s WHERE s.key = '${ASM_TRANSFER_VISIT_LIMIT_KEY}' LIMIT 1
), ${ASM_TRANSFER_VISIT_LIMIT_DEFAULT})`);

/** When the lead (aliased `dl`) last entered Transferred_to_ASM — raw SQL text. */
export const TRANSFER_AT_EXPR = `COALESCE((
    SELECT MAX(h.changed_at) FROM dealer_lead_status_history h
     WHERE h.dealer_lead_id = dl.id AND h.to_status = 'Transferred_to_ASM'
), dl.assigned_at, dl.created_at)`;

/** Working days (Mon–Sat, IST) since the transfer — an int scalar. */
export const TRANSFER_WORKING_DAYS_SQL: SQL = sql.raw(`(
    SELECT COUNT(*) FROM generate_series(
        ((${TRANSFER_AT_EXPR}) AT TIME ZONE 'Asia/Kolkata')::date + 1,
        (NOW() AT TIME ZONE 'Asia/Kolkata')::date, INTERVAL '1 day'
    ) gs WHERE EXTRACT(DOW FROM gs) <> 0
)::int`);

/** Boolean predicate over `dl`: the transfer's first visit is overdue. */
export const TRANSFER_VISIT_OVERDUE_SQL: SQL = sql`(
    dl.lead_status = 'Transferred_to_ASM'
    AND dl.is_active IS NOT FALSE
    AND ${TRANSFER_WORKING_DAYS_SQL} > ${TRANSFER_VISIT_LIMIT_SQL}
    AND NOT EXISTS (
        SELECT 1 FROM lead_visits v
         WHERE v.dealer_lead_id = dl.id
           AND v.visit_status = 'visited'
           AND (v.created_at >= ${sql.raw(TRANSFER_AT_EXPR)}
                OR v.actual_visit_date >= ((${sql.raw(TRANSFER_AT_EXPR)}) AT TIME ZONE 'Asia/Kolkata')::date)
    )
)`;

export type AsmTransferVisitLimit = {
    days: number;
    updated_by_name: string | null;
    updated_at: string | null;
};

/** Never throws — a failed read is the default. */
export async function getAsmTransferVisitLimit(): Promise<AsmTransferVisitLimit> {
    try {
        const rows = await db.execute<{
            value: unknown;
            updated_at: string | null;
            updated_by_name: string | null;
        }>(sql`
            SELECT s.value, s.updated_at, u.name AS updated_by_name
              FROM app_settings s
              LEFT JOIN users u ON u.id::text = s.value->>'updated_by'
             WHERE s.key = ${ASM_TRANSFER_VISIT_LIMIT_KEY}
             LIMIT 1
        `);
        const row = (rows as unknown as Record<string, unknown>[])[0];
        const days = Number((row?.value as { days?: unknown } | undefined)?.days);
        return {
            days: Number.isInteger(days) && days >= 1 ? days : ASM_TRANSFER_VISIT_LIMIT_DEFAULT,
            updated_by_name: row?.updated_by_name == null ? null : String(row.updated_by_name),
            updated_at: row?.updated_at ? new Date(row.updated_at as string).toISOString() : null,
        };
    } catch (e) {
        console.warn("[transferVisitLimit] read failed — using the default", {
            error: e instanceof Error ? e.message : String(e),
        });
        return { days: ASM_TRANSFER_VISIT_LIMIT_DEFAULT, updated_by_name: null, updated_at: null };
    }
}

/** Throws on a DB failure (the admin must know). */
export async function setAsmTransferVisitLimit(days: number, updatedBy: string): Promise<AsmTransferVisitLimit> {
    const value = { days, updated_by: updatedBy };
    const now = new Date().toISOString();
    await db.execute(sql`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (${ASM_TRANSFER_VISIT_LIMIT_KEY}, ${JSON.stringify(value)}::jsonb, ${now}::timestamptz)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `);
    return getAsmTransferVisitLimit();
}
