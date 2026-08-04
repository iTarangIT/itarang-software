// POST /api/neodove/campaigns/[id]/push
//
// Resolve the campaign's audience → seed neodove_lead_links as `pending` →
// fast-ack → push in after() with a concurrency cap.
//
// WHY THE LINKS ARE SEEDED BEFORE THE ACK. The unique index on
// (dealer_lead_id, neodove_campaign_id) makes the seed itself the idempotency
// guard: a double-clicked push inserts zero new rows the second time and has
// nothing left to send. Doing it after the ack would leave a window where two
// concurrent pushes both see an empty link table.
//
// WHY CONCURRENCY IS LOW BY DEFAULT. NeoDove documents no rate limits at all.
// The safe reading of "undocumented" is "exists, and you'll find it the hard
// way" — so 5 concurrent with a 250ms pacing delay, both env-tunable.

import { after } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import {
    errorMessage,
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";
import { resolveAudience, type AudienceSelection } from "@/lib/ai-dialer/audience";
import { getNeodoveConfig } from "@/lib/neodove/config";
import { pushLead } from "@/lib/neodove/client";
import { dealerLeadToNeodove, type PushableLead } from "@/lib/neodove/mapper";
import { NEODOVE_ADMIN_ROLES } from "@/lib/neodove/roles";

export const runtime = "nodejs";
export const maxDuration = 300;

type CampaignRow = {
    id: string;
    name: string;
    push_endpoint_ref: string | null;
    audience_filter: unknown;
    status: string;
};

export const POST = withErrorHandler(
    async (req: Request, context: { params: Promise<{ id: string }> }) => {
        await requireRole(NEODOVE_ADMIN_ROLES);
        const { id } = await context.params;

        const cfg = getNeodoveConfig();
        if (!cfg.enabled) {
            return errorResponse(
                "NeoDove integration is disabled. Set NEODOVE_ENABLED=true once the Custom Integration endpoint is configured.",
                409,
            );
        }

        const campaigns = await db.execute<CampaignRow>(sql`
            SELECT id, name, push_endpoint_ref, audience_filter, status
              FROM neodove_campaigns WHERE id = ${id} LIMIT 1
        `);
        const campaign = campaigns[0];
        if (!campaign) return errorResponse("Campaign not found", 404);
        if (!campaign.push_endpoint_ref) {
            return errorResponse(
                "This campaign has no push endpoint configured. Set push_endpoint_ref to the name of the env var holding its NeoDove Custom Integration URL.",
                409,
            );
        }

        const body = await req.json().catch(() => ({}));
        const selection: AudienceSelection =
            body && Object.keys(body).length > 0
                ? body
                : ((campaign.audience_filter as AudienceSelection) ?? {});

        // Audience is resolved SERVER-side at push time, never taken from the
        // client — a stale tab must not be able to push leads the operator
        // never saw. resolveAudience already applies the BRD §0.2 exclusion
        // filter, so leads Inside Sales or an ASM are actively working are
        // never handed to a NeoDove agent.
        const audience = await resolveAudience(selection);
        if (audience.queueIds.length === 0) {
            return errorResponse("This audience resolves to zero leads.", 400);
        }

        // Seed links. ON CONFLICT DO NOTHING means re-pushing a campaign only
        // picks up leads that are new to it.
        const idsJson = JSON.stringify(audience.queueIds);
        await db.execute(sql`
            INSERT INTO neodove_lead_links (dealer_lead_id, neodove_campaign_id, push_status)
            SELECT lead_id, ${id}, 'pending'
              FROM jsonb_array_elements_text(${idsJson}::jsonb) AS lead_id
            ON CONFLICT (dealer_lead_id, neodove_campaign_id) DO NOTHING
        `);

        const pending = await db.execute<{ count: string }>(sql`
            SELECT COUNT(*)::text AS count FROM neodove_lead_links
             WHERE neodove_campaign_id = ${id} AND push_status = 'pending'
        `);
        const pendingCount = Number(pending[0]?.count ?? 0);

        await db.execute(sql`
            UPDATE neodove_campaigns
               SET status = 'pushing', started_at = COALESCE(started_at, NOW()), updated_at = NOW()
             WHERE id = ${id}
        `);

        // Heavy work out of the request path.
        after(async () => {
            try {
                await drainCampaign(id, campaign.push_endpoint_ref!);
            } catch (err) {
                console.error("[NeoDove/push] drain failed:", errorMessage(err));
            }
        });

        return successResponse({
            campaignId: id,
            audienceResolved: audience.queueIds.length,
            queued: pendingCount,
            excluded: audience.excluded,
            status: "pushing",
        });
    },
);

/**
 * Push every `pending` link for a campaign, in bounded-concurrency batches.
 *
 * Re-reads the pending set from the DB rather than trusting the caller's list,
 * so a resumed or retried drain never re-sends something already marked pushed.
 */
async function drainCampaign(campaignId: string, endpointRef: string): Promise<void> {
    const { pushConcurrency, pushDelayMs } = getNeodoveConfig();

    const leads = await db.execute<PushableLead & { link_id: string }>(sql`
        SELECT l.id::text AS link_id,
               dl.id, dl.phone, dl.dealer_name, dl.shop_name, dl.city, dl.state,
               dl.area, dl.pincode, dl.language, dl.source, dl.lead_status,
               dl.interest_level
          FROM neodove_lead_links l
          JOIN dealer_leads dl ON dl.id = l.dealer_lead_id
         WHERE l.neodove_campaign_id = ${campaignId} AND l.push_status = 'pending'
    `);

    let pushed = 0;
    let failed = 0;

    for (let i = 0; i < leads.length; i += pushConcurrency) {
        const batch = leads.slice(i, i + pushConcurrency);

        const results = await Promise.all(
            batch.map(async (lead) => {
                const payload = dealerLeadToNeodove(lead);
                if (!payload) {
                    // No usable mobile — NeoDove's only mandatory field. Mark
                    // it rather than retrying forever.
                    await db.execute(sql`
                        UPDATE neodove_lead_links
                           SET push_status = 'skipped_excluded',
                               push_error = 'No valid Indian mobile on this lead'
                         WHERE id = ${lead.link_id}::uuid
                    `);
                    return false;
                }

                const result = await pushLead({
                    endpointRef,
                    payload,
                    campaignId,
                    dealerLeadId: lead.id,
                });

                await db.execute(sql`
                    UPDATE neodove_lead_links
                       SET push_status = ${result.ok ? "pushed" : "failed"},
                           push_error = ${result.error},
                           neodove_lead_id = COALESCE(${result.neodoveLeadId}, neodove_lead_id),
                           pushed_at = ${result.ok ? sql`NOW()` : sql`pushed_at`}
                     WHERE id = ${lead.link_id}::uuid
                `);

                await db.execute(sql`
                    UPDATE dealer_leads
                       SET neodove_synced_at = NOW(),
                           neodove_sync_status = ${result.ok ? "pushed" : "failed"}
                     WHERE id = ${lead.id}
                `);

                return result.ok;
            }),
        );

        pushed += results.filter(Boolean).length;
        failed += results.filter((r) => r === false).length;

        if (i + pushConcurrency < leads.length && pushDelayMs > 0) {
            await new Promise((r) => setTimeout(r, pushDelayMs));
        }
    }

    await db.execute(sql`
        UPDATE neodove_campaigns
           SET total_pushed = total_pushed + ${pushed},
               push_failed = push_failed + ${failed},
               status = 'active',
               updated_at = NOW()
         WHERE id = ${campaignId}
    `);

    console.log(
        `[NeoDove/push] campaign ${campaignId}: ${pushed} pushed, ${failed} failed`,
    );
}
