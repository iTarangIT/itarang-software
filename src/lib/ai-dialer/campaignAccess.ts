// Who may read the AI-dialer campaign APIs, and what a rep sees (tracker ID 45).
//
// These routes had NO auth at all: any signed-in user — or anyone, since
// middleware does not gate /api/* — could list every campaign lead with phone
// numbers, and read any call transcript. Readers are the /leads roles (the
// campaign views are mounted on /leads, sales-head, inside-sales, asm and
// partner); a dealer / NBFC / vendor login gets 403.
//
// Reps (asm, inside_sales_rep, partner — the ID 58 own-leads-only roles) see
// only the campaign leads they OWN: a campaign spans the unowned pool, and the
// lead rows carry names and numbers. Campaign-wide COUNTS stay visible to them
// (as the export's Campaign sheet does). Transcript / intent feedback of a lead
// they don't own is a 404, not a 403 — same answer as "no such lead".

import { eq, sql, type SQL } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { LEADS_PAGE_ROLES } from "@/lib/leads/access";
import { exportsOwnLeadsOnly } from "@/lib/exports/downloadLog";

export const CAMPAIGN_READ_ROLES: readonly string[] = LEADS_PAGE_ROLES;

export async function requireCampaignReader() {
    const user = await requireRole([...CAMPAIGN_READ_ROLES]);
    return { user, ownOnly: exportsOwnLeadsOnly(user.role) };
}

/** Drizzle condition over the joined dealer_leads row: owned by `userId`. */
export function ownedByCondition(userId: string): SQL {
    return eq(dealerLeads.current_owner_id, userId);
}

/** Does `userId` own lead `leadId`? (false for a missing lead) */
export async function leadOwnedBy(leadId: string, userId: string): Promise<boolean> {
    const rows = (await db.execute<{ ok: boolean }>(sql`
        SELECT TRUE AS ok FROM dealer_leads WHERE id = ${leadId} AND current_owner_id = ${userId} LIMIT 1
    `)) as unknown as Array<{ ok: boolean }>;
    return rows.length > 0;
}
