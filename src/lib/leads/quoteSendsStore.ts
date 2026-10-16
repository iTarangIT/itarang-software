/**
 * Tracker ID 191 — every quote send on one lead (quotation_dispatches), for the
 * lead page's quote card and timelines. Rules and wording: ./quoteSends.ts.
 *
 * Read-only. Never throws: a database without the table (or any failure)
 * yields no sends, so the lead page still loads.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { displayRecipient, type QuoteSend } from "@/lib/leads/quoteSends";

export async function listLeadQuoteSends(leadId: string): Promise<QuoteSend[]> {
    try {
        const rows = (await db.execute(sql`
            SELECT d.dispatch_id::text AS dispatch_id, d.commercial_id::text AS commercial_id,
                   c.quote_number, d.channel, d.recipient, d.status, d.error,
                   u.name AS sent_by_name,
                   to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sent_at
              FROM quotation_dispatches d
              LEFT JOIN dealer_lead_commercials c ON c.commercial_id = d.commercial_id
              -- sent_by is text, users.id uuid: cast the uuid (as listDispatches does).
              LEFT JOIN users u ON u.id::text = d.sent_by
             WHERE d.dealer_lead_id = ${leadId}
             ORDER BY d.created_at DESC
             LIMIT 200
        `)) as unknown as Array<Omit<QuoteSend, "recipient"> & { recipient: string | null }>;
        return rows.map((r) => ({ ...r, recipient: displayRecipient(r.channel, r.recipient) }));
    } catch (err) {
        console.warn("[quoteSends] sends unavailable", leadId, err);
        return [];
    }
}
