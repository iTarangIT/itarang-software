// Ecofy follow-up / meeting reminders (E-307), run by the in-process ticker
// (src/instrumentation-node.ts → startEcofyReminderTicker).
//
// Due times are the ones CRM users set when logging a follow-up or booking a
// meeting (ecofy_leads.next_follow_up_at / next_appointment_at). Each reminder
// fires once: the row is claimed with UPDATE … RETURNING, which stamps
// *_reminded_at in the same statement, so two app instances cannot both send it.
// "Due" is decided by Postgres now(), never the Node clock (clock-skew rule).

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { errorMessage } from "@/lib/api-utils";
import { notifyEcofyReminder } from "./notify";

/** Meetings are announced this far ahead. */
const APPOINTMENT_LEAD_MINUTES = 60;

export async function runEcofyReminderTick(): Promise<{
    followUps: number;
    appointments: number;
    synced: number;
    assignmentsSynced: number;
}> {
    // Leads assigned in the CRM that Ecofy still shows at S1: re-send
    // `lead.assigned` so Ecofy moves them to S2 (refused while the integration
    // user was missing, or Ecofy was down at assign time).
    let assignmentsSynced = 0;
    try {
        const { retryPendingEcofyAssignments } = await import("./assignment");
        assignmentsSynced = (await retryPendingEcofyAssignments()).synced;
    } catch (err) {
        console.error("[Ecofy/reminders] assignment retry failed:", errorMessage(err));
    }

    // E-308 — replay work the CRM kept while Ecofy was unavailable.
    let synced = 0;
    try {
        const { syncPendingEcofyActivities } = await import("./localActivities");
        synced = (await syncPendingEcofyActivities()).synced;
    } catch (err) {
        console.error("[Ecofy/reminders] pending sync failed:", errorMessage(err));
    }

    const followUps = await db.execute<{ id: string; at: string }>(sql`
        UPDATE ecofy_leads SET follow_up_reminded_at = now()
        WHERE next_follow_up_at IS NOT NULL
          AND follow_up_reminded_at IS NULL
          AND next_follow_up_at <= now()
          AND stage NOT IN ('S0', 'CLOSED')
        RETURNING id::text AS id, next_follow_up_at AS at
    `);
    const appointments = await db.execute<{ id: string; at: string }>(sql`
        UPDATE ecofy_leads SET appointment_reminded_at = now()
        WHERE next_appointment_at IS NOT NULL
          AND appointment_reminded_at IS NULL
          AND next_appointment_at <= now() + make_interval(mins => ${APPOINTMENT_LEAD_MINUTES})
          AND next_appointment_at > now() - interval '1 hour'
          AND stage NOT IN ('S0', 'CLOSED')
        RETURNING id::text AS id, next_appointment_at AS at
    `);

    for (const r of followUps) {
        try {
            await notifyEcofyReminder({ leadId: r.id, kind: "follow_up", at: new Date(r.at) });
        } catch (err) {
            console.error("[Ecofy/reminders] follow-up notify failed:", errorMessage(err));
        }
    }
    for (const r of appointments) {
        try {
            await notifyEcofyReminder({ leadId: r.id, kind: "appointment", at: new Date(r.at) });
        } catch (err) {
            console.error("[Ecofy/reminders] appointment notify failed:", errorMessage(err));
        }
    }
    return { followUps: followUps.length, appointments: appointments.length, synced, assignmentsSynced };
}

/** Called after a successful CRM action so the ticker knows what is due. */
export async function recordEcofyDueTimes(
    leadId: string,
    change:
        | { kind: "follow_up"; at: string }
        | { kind: "appointment_booked"; at: string }
        | { kind: "appointment_rescheduled"; at: string }
        | { kind: "appointment_done" },
): Promise<void> {
    try {
        if (change.kind === "follow_up") {
            await db.execute(sql`
                UPDATE ecofy_leads
                SET next_follow_up_at = ${change.at}::timestamptz, follow_up_reminded_at = NULL, updated_at = now()
                WHERE id = ${leadId}::uuid
            `);
        } else if (change.kind === "appointment_booked") {
            // Keep the EARLIEST upcoming meeting: a later booking must not hide
            // a sooner one that has not been reminded yet.
            await db.execute(sql`
                UPDATE ecofy_leads
                SET next_appointment_at = ${change.at}::timestamptz, appointment_reminded_at = NULL, updated_at = now()
                WHERE id = ${leadId}::uuid
                  AND (next_appointment_at IS NULL
                       OR next_appointment_at < now()
                       OR appointment_reminded_at IS NOT NULL
                       OR ${change.at}::timestamptz < next_appointment_at)
            `);
        } else if (change.kind === "appointment_rescheduled") {
            await db.execute(sql`
                UPDATE ecofy_leads
                SET next_appointment_at = ${change.at}::timestamptz, appointment_reminded_at = NULL, updated_at = now()
                WHERE id = ${leadId}::uuid
            `);
        } else {
            await db.execute(sql`
                UPDATE ecofy_leads SET next_appointment_at = NULL, updated_at = now()
                WHERE id = ${leadId}::uuid
            `);
        }
    } catch (err) {
        console.error("[Ecofy/reminders] record due time failed:", errorMessage(err));
    }
}
