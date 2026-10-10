// Handing a lead that is Awaiting field visit (Transferred_to_ASM) back to an
// ISR / partner (tracker ID 121, business rule 3 Oct 2026, Kartik):
//
//   1. If the ASM has a visit booked for today or later, the hand-back is
//      REFUSED with the reason — cancel or complete the visit first. An ASM's
//      follow-up is a visit too (recordVisit's next_visit_date books one), so
//      this one check covers "visit or follow-up". dealer_leads.next_follow_up_at
//      is not counted: no ASM screen can set or clear it, so a block on it
//      could never be lifted by the ASM.
//   2. With nothing booked, the hand-back unlinks the ASM (asm_id = NULL) and
//      closes the lead's open visits (pending_scheduling, or a scheduled date
//      already past) as cancelled. Before this the ASM kept the lead on Today
//      and could not log the visit, and the ISR never knew one was planned.
//
// Every path applies it: admin / bulk / NeoDove through assignOwner.ts, the
// ASM's own Reassign and the WhatsApp Assistant through reassign.ts.
// Dates compare against Postgres CURRENT_DATE, never the Node clock.

import { sql } from "drizzle-orm";
import type { db } from "@/lib/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Pick<Tx, "execute">;

/** The roles a transferred lead is "handed back" to. */
export const HAND_BACK_ROLES: readonly string[] = ["inside_sales_rep", "partner"];

export function isHandBack(fromStatus: string | null | undefined, targetRole: string | null | undefined): boolean {
    return fromStatus === "Transferred_to_ASM" && HAND_BACK_ROLES.includes(targetRole ?? "");
}

export type BookedVisit = {
    /** lead_visits.scheduled_date, YYYY-MM-DD. */
    scheduledDate: string;
    asmName: string | null;
};

/** "2026-10-12" → "12 Oct". Pure. */
function shortDate(ymd: string): string {
    const [y, m, d] = ymd.split("-").map(Number);
    if (!y || !m || !d) return ymd;
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
    });
}

/** The refusal sentence for a booked visit, or null when the hand-back may go ahead. Pure. */
export function handBackBlockReason(visit: BookedVisit | null): string | null {
    if (!visit) return null;
    const who = visit.asmName?.trim() || "The ASM";
    return (
        `${who} has a visit booked for ${shortDate(visit.scheduledDate)}. ` +
        `Cancel or complete the visit first, then hand the lead back.`
    );
}

/** Refused before anything is written; withErrorHandler / callers answer 409 with the sentence. */
export class AsmVisitBookedError extends Error {
    readonly status = 409;
    constructor(message: string) {
        super(message);
        this.name = "AsmVisitBookedError";
    }
}

/** The earliest visit booked for today or later on this lead, if any. */
export async function findBookedVisit(ex: Executor, leadId: string): Promise<BookedVisit | null> {
    const rows = (await ex.execute<{ scheduled_date: string; asm_name: string | null }>(sql`
        SELECT lv.scheduled_date::text AS scheduled_date, u.name AS asm_name
          FROM lead_visits lv
          LEFT JOIN users u ON u.id::text = lv.asm_id
         WHERE lv.dealer_lead_id = ${leadId}
           AND lv.visit_status = 'scheduled'
           AND lv.scheduled_date >= CURRENT_DATE
         ORDER BY lv.scheduled_date
         LIMIT 1
    `)) as unknown as Array<{ scheduled_date: string; asm_name: string | null }>;
    const row = rows[0];
    return row ? { scheduledDate: row.scheduled_date, asmName: row.asm_name } : null;
}

/** The refusal for handing this lead back right now, or null. */
export async function handBackRefusal(ex: Executor, leadId: string): Promise<string | null> {
    return handBackBlockReason(await findBookedVisit(ex, leadId));
}

/**
 * Unlink the ASM and close the lead's open visits. Call only after
 * handBackRefusal came back null, in the same transaction as the owner swap.
 * Returns how many visits were closed.
 */
export async function releaseAsm(tx: Executor, leadId: string, note: string): Promise<number> {
    await tx.execute(sql`
        UPDATE dealer_leads SET asm_id = NULL, updated_at = NOW() WHERE id = ${leadId}
    `);
    const closed = (await tx.execute<{ visit_id: string }>(sql`
        UPDATE lead_visits
           SET visit_status = 'cancelled',
               visit_remarks = concat_ws(' · ', NULLIF(visit_remarks, ''), ${note}::text),
               updated_at = NOW()
         WHERE dealer_lead_id = ${leadId}
           AND visit_status IN ('scheduled', 'pending_scheduling')
        RETURNING visit_id
    `)) as unknown as Array<{ visit_id: string }>;
    return closed.length;
}

/** "ASM unlinked; 1 open visit closed." — for the touchpoint's reason notes. Pure. */
export function releaseNote(closedVisits: number): string {
    if (closedVisits === 0) return "ASM unlinked.";
    return `ASM unlinked; ${closedVisits} open visit${closedVisits === 1 ? "" : "s"} closed.`;
}
