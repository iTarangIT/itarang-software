// ID 235: which NeoDove campaign a lead is in, and the campaign a new owner's
// leads go to — for the lead page line ('NeoDove campaign: <name>, sent <date>')
// and Reassign's 'Also move to <new owner>'s NeoDove campaign'.
//
// Reads only. Columns added by E-237 (crm_owner_user_id) are read through
// to_jsonb so a database without that migration answers "none", not a 500.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { type LeadNeodoveCampaign, type OwnerCampaign } from "./leadCampaignText";

export * from "./leadCampaignText";

type LinkRow = {
    campaign_id: string;
    name: string;
    neodove_name: string | null;
    push_status: string;
    pushed_at: Date | string | null;
    push_error: string | null;
};

const iso = (v: Date | string | null): string | null => (v == null ? null : new Date(v).toISOString());

/** The lead's most recent NeoDove push (sent or refused), or null when never pushed. */
export async function leadNeodoveCampaign(leadId: string): Promise<LeadNeodoveCampaign | null> {
    try {
        const rows = (await db.execute<LinkRow>(sql`
            SELECT nc.id AS campaign_id, nc.name, nc.neodove_campaign_name AS neodove_name,
                   nll.push_status, nll.pushed_at, nll.push_error
              FROM neodove_lead_links nll
              JOIN neodove_campaigns nc ON nc.id = nll.neodove_campaign_id
             WHERE nll.dealer_lead_id = ${leadId}
             ORDER BY COALESCE(nll.pushed_at, nll.created_at) DESC
             LIMIT 1
        `)) as unknown as LinkRow[];
        const r = rows[0];
        return r ? { ...r, pushed_at: iso(r.pushed_at) } : null;
    } catch {
        return null; // never fails the lead page
    }
}

/**
 * The campaign whose CRM owner (E-237) is this user and that can take a push.
 * Several → the most recently started active one.
 */
export async function ownerNeodoveCampaign(userId: string): Promise<OwnerCampaign | null> {
    try {
        const rows = (await db.execute<OwnerCampaign>(sql`
            SELECT c.id AS campaign_id, c.name, c.neodove_campaign_name AS neodove_name
              FROM neodove_campaigns c
             WHERE to_jsonb(c) ->> 'crm_owner_user_id' = ${userId}
               AND c.push_endpoint_ref IS NOT NULL
               AND c.status <> 'completed'
             ORDER BY (c.status = 'active') DESC, COALESCE(c.started_at, c.created_at) DESC
             LIMIT 1
        `)) as unknown as OwnerCampaign[];
        return rows[0] ?? null;
    } catch {
        return null;
    }
}

