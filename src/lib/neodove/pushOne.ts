// Push exactly one lead to one NeoDove campaign (E-224, extracted at E-226).
//
// Extracted from POST /api/neodove/leads/[id]/push when the priority-dial
// action (POST .../dial) became a second caller of the same sequence. That
// sequence is not one HTTP call — it is a push plus four bookkeeping writes
// (link upsert, dealer_leads sync columns, and one of two campaign counters),
// and every one of them is what reconciliation later diffs against. Two copies
// of it would drift, and the drift would be invisible: both routes would still
// return 200 while one quietly stopped moving a counter.
//
// Deliberately NOT responsible for touchpoints. The plain push is a bulk-shaped
// action — pushing 500 leads must not write 500 timeline entries — whereas the
// dial action is a single deliberate act that SHOULD appear on the lead. So the
// caller owns that decision.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { isAiDialable } from "@/lib/ai-dialer/exclusionFilter";
import { pushLead } from "./client";
import { dealerLeadToNeodove, type PushableLead } from "./mapper";

type LeadRow = PushableLead & { ai_recall_status: string | null };

export type PushOneResult =
    | {
          ok: true;
          neodoveLeadId: string | null;
          campaignId: string;
          campaignName: string | null;
          leadName: string;
      }
    | { ok: false; status: number; message: string };

/**
 * Resolve a campaign, check the exclusion rule, push, and record the outcome.
 *
 * `force` is the escape hatch for a deliberate hand-off of an actively-worked
 * lead. Not a default: BRD §0.2 exists so that NeoDove and an ASM are never
 * dialling the same dealer, and overriding it has to be an explicit, auditable
 * choice rather than something a button does quietly.
 */
export async function pushOneLead(input: {
    leadId: string;
    campaignId: string;
    force?: boolean;
}): Promise<PushOneResult> {
    const campaigns = await db.execute<{
        id: string;
        push_endpoint_ref: string | null;
        neodove_campaign_name: string | null;
    }>(sql`
        SELECT id, push_endpoint_ref, neodove_campaign_name
          FROM neodove_campaigns WHERE id = ${input.campaignId} LIMIT 1
    `);
    const campaign = campaigns[0];
    if (!campaign) return { ok: false, status: 404, message: "Campaign not found" };
    if (!campaign.push_endpoint_ref) {
        return {
            ok: false,
            status: 409,
            message: "This campaign has no push endpoint configured.",
        };
    }

    const leads = await db.execute<LeadRow>(sql`
        SELECT id, phone, dealer_name, shop_name, city, state, area, pincode,
               language, source, lead_status, interest_level, ai_recall_status
          FROM dealer_leads WHERE id = ${input.leadId} LIMIT 1
    `);
    const lead = leads[0];
    if (!lead) return { ok: false, status: 404, message: "Lead not found" };

    if (!input.force && !isAiDialable(lead)) {
        return {
            ok: false,
            status: 409,
            message: `This lead is at status "${lead.lead_status}" — someone is already working it. Pass force:true to hand it to NeoDove anyway.`,
        };
    }

    const payload = dealerLeadToNeodove(lead);
    if (!payload) {
        return {
            ok: false,
            status: 400,
            message: "Lead has no valid 10-digit Indian mobile — NeoDove requires one.",
        };
    }

    const result = await pushLead({
        endpointRef: campaign.push_endpoint_ref,
        payload,
        campaignId: campaign.id,
        dealerLeadId: lead.id,
    });

    await db.execute(sql`
        INSERT INTO neodove_lead_links
            (dealer_lead_id, neodove_campaign_id, neodove_lead_id, push_status,
             push_error, pushed_at)
        VALUES (${lead.id}, ${campaign.id}, ${result.neodoveLeadId},
                ${result.ok ? "pushed" : "failed"}, ${result.error},
                ${result.ok ? sql`NOW()` : sql`NULL`})
        ON CONFLICT (dealer_lead_id, neodove_campaign_id) DO UPDATE
            SET push_status = EXCLUDED.push_status,
                push_error = EXCLUDED.push_error,
                neodove_lead_id = COALESCE(EXCLUDED.neodove_lead_id,
                                           neodove_lead_links.neodove_lead_id),
                pushed_at = COALESCE(EXCLUDED.pushed_at, neodove_lead_links.pushed_at)
    `);

    await db.execute(sql`
        UPDATE dealer_leads
           SET neodove_synced_at = NOW(),
               neodove_sync_status = ${result.ok ? "pushed" : "failed"}
         WHERE id = ${lead.id}
    `);

    if (!result.ok) {
        await db.execute(sql`
            UPDATE neodove_campaigns
               SET push_failed = push_failed + 1, updated_at = NOW()
             WHERE id = ${campaign.id}
        `);
        return { ok: false, status: 502, message: result.error ?? "Push failed" };
    }

    await db.execute(sql`
        UPDATE neodove_campaigns
           SET total_pushed = total_pushed + 1, updated_at = NOW()
         WHERE id = ${campaign.id}
    `);

    return {
        ok: true,
        neodoveLeadId: result.neodoveLeadId,
        campaignId: campaign.id,
        campaignName: campaign.neodove_campaign_name,
        leadName: lead.dealer_name || lead.shop_name || lead.id,
    };
}

/**
 * The campaign marked `is_priority_dial` (E-226), if there is one.
 *
 * Read through `to_jsonb` rather than naming the column: a missing column fails
 * a statement at PARSE time, which would take the whole dial route down on any
 * DB without E-226 rather than telling the operator to configure a destination.
 * Resolved at runtime instead — no column, no rows, honest 409.
 */
export async function getPriorityDialCampaign(): Promise<{
    id: string;
    name: string;
    neodove_campaign_name: string | null;
    push_endpoint_ref: string | null;
} | null> {
    const rows = await db.execute<{
        id: string;
        name: string;
        neodove_campaign_name: string | null;
        push_endpoint_ref: string | null;
    }>(sql`
        SELECT c.id, c.name, c.neodove_campaign_name, c.push_endpoint_ref
          FROM neodove_campaigns c
         WHERE (to_jsonb(c) ->> 'is_priority_dial') = 'true'
         LIMIT 1
    `);
    return rows[0] ?? null;
}
