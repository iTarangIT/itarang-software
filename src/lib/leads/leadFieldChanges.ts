// Who changed a lead's details, when, and from what to what (tracker ID 132).
//
// The rows are written by the E-304 trigger on dealer_leads
// (dealer_leads_audit_fn → dealer_lead_field_changes), not by application code:
// any UPDATE of an audited column records old and new value, and the actor
// comes from `app.actor_id`, which withLeadActor() sets. So a changed phone
// number keeps the old number here without the edit route doing anything.
//
// Read-only. Returns [] on a database without E-304 rather than failing the
// page — same tolerance as eventLog.ts.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

export type LeadFieldChange = {
    id: string;
    field: string;
    old_value: string | null;
    new_value: string | null;
    changed_by_name: string | null;
    /** IST, "05 Oct 2026, 14:32". */
    changed_at: string;
};

export async function leadFieldChanges(leadId: string, limit = 50): Promise<LeadFieldChange[]> {
    try {
        const rows = (await db.execute(sql`
            SELECT fc.id::text AS id,
                   fc.field,
                   fc.old_value,
                   fc.new_value,
                   u.name AS changed_by_name,
                   to_char(fc.changed_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY, HH24:MI') AS changed_at
              FROM dealer_lead_field_changes fc
              LEFT JOIN users u ON u.id::text = fc.changed_by::text
             WHERE fc.dealer_lead_id = ${leadId}
             ORDER BY fc.changed_at DESC
             LIMIT ${limit}
        `)) as unknown as LeadFieldChange[];
        return [...rows];
    } catch {
        return [];
    }
}
