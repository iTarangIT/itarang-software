// POST /api/neodove/leads/push-batch
//
// Hand an EXPLICIT list of leads to a NeoDove campaign — the "tick these rows
// and send them" action on the leads list.
//
// This sits between the two push routes that already exist:
//   leads/[id]/push        — one lead, synchronous, caller gets a real answer
//   campaigns/[id]/push    — a whole audience, resolved server-side from a filter
// Neither covers "these 30, chosen by hand", which is what an operator working
// a list actually does.
//
// WHY THE ID LIST IS TRUSTED HERE BUT NOT IN THE CAMPAIGN PUSH. The campaign
// route deliberately re-resolves its audience server-side so a stale tab cannot
// push leads the operator never saw. Here the ids ARE what the operator saw and
// chose — that is the whole point of the action. The protection that matters is
// therefore applied per lead instead: every id is re-read from the DB and
// re-checked against the BRD §0.2 exclusion rule at push time, so a lead that
// became actively-worked since the page loaded is skipped, not sent.
//
// WHY IT ACKS BEFORE PUSHING. Same reasoning as campaigns/[id]/push — with
// pacing at 250ms and concurrency 5, a 500-lead selection outlives any sane
// request timeout. The result is watched on the Sync Activity screen.

import { after } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import {
    errorMessage,
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";
import { isAiDialable } from "@/lib/ai-dialer/exclusionFilter";
import { getNeodoveConfig } from "@/lib/neodove/config";
import { pushLead } from "@/lib/neodove/client";
import { dealerLeadToNeodove, type PushableLead } from "@/lib/neodove/mapper";
import { NEODOVE_ADMIN_ROLES } from "@/lib/neodove/roles";

export const runtime = "nodejs";
export const maxDuration = 300;

// A hand-made selection is bounded by what a human can meaningfully review.
// Anything larger is an audience, and audiences belong on the campaign push
// where they get a mandatory preview of the exact count first.
const MAX_BATCH = 500;

const bodySchema = z.object({
    campaignId: z.string().trim().min(1, "campaignId is required"),
    leadIds: z
        .array(z.string().trim().min(1))
        .min(1, "Select at least one lead")
        .max(MAX_BATCH, `Select at most ${MAX_BATCH} leads — use a campaign audience push for more`),
    // Deliberate hand-off of actively-worked leads. Applies to the whole batch,
    // so the UI states how many it overrides before asking for it.
    force: z.boolean().optional(),
});

type LeadRow = PushableLead & { ai_recall_status: string | null };

export const POST = withErrorHandler(async (req: Request) => {
    await requireRole(NEODOVE_ADMIN_ROLES);

    const cfg = getNeodoveConfig();
    if (!cfg.enabled) {
        return errorResponse(
            "NeoDove integration is disabled. Set NEODOVE_ENABLED=true once the Custom Integration endpoint is configured.",
            409,
        );
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return errorResponse(
            parsed.error.issues.map((i) => i.message).join("; "),
            400,
        );
    }
    const { campaignId, force } = parsed.data;
    // De-duplicate: the same lead ticked twice must not consume two quota slots
    // or double-count total_pushed.
    const leadIds = [...new Set(parsed.data.leadIds)];

    const campaigns = await db.execute<{ push_endpoint_ref: string | null }>(sql`
        SELECT push_endpoint_ref FROM neodove_campaigns WHERE id = ${campaignId} LIMIT 1
    `);
    if (!campaigns[0]) return errorResponse("Campaign not found", 404);
    const endpointRef = campaigns[0].push_endpoint_ref;
    if (!endpointRef) {
        return errorResponse(
            "This campaign has no push endpoint configured. Set push_endpoint_ref to the name of the env var holding its NeoDove Custom Integration URL.",
            409,
        );
    }

    const idsJson = JSON.stringify(leadIds);

    const leads = await db.execute<LeadRow>(sql`
        SELECT id, phone, dealer_name, shop_name, city, state, area, pincode,
               language, source, lead_status, interest_level, ai_recall_status
          FROM dealer_leads
         WHERE id IN (SELECT value FROM jsonb_array_elements_text(${idsJson}::jsonb))
    `);

    // Partition before sending anything, so the caller learns what will NOT be
    // sent at the same moment it learns what will.
    const eligible: LeadRow[] = [];
    const skipped = { notFound: 0, noPhone: 0, activelyWorked: 0 };

    skipped.notFound = leadIds.length - leads.length;

    for (const lead of leads) {
        if (!force && !isAiDialable(lead)) {
            skipped.activelyWorked += 1;
            continue;
        }
        if (!dealerLeadToNeodove(lead)) {
            skipped.noPhone += 1;
            continue;
        }
        eligible.push(lead);
    }

    if (eligible.length === 0) {
        return errorResponse(
            skipped.activelyWorked > 0
                ? `None of the ${leadIds.length} selected leads can be sent — ${skipped.activelyWorked} are already being worked by someone. Re-send with force to hand them over anyway.`
                : "None of the selected leads have a valid Indian mobile.",
            409,
        );
    }

    // Seeding the links IS the idempotency guard: the unique index on
    // (dealer_lead_id, neodove_campaign_id) means a double-clicked send inserts
    // zero rows the second time and the drain finds nothing pending.
    const eligibleJson = JSON.stringify(eligible.map((l) => l.id));
    await db.execute(sql`
        INSERT INTO neodove_lead_links (dealer_lead_id, neodove_campaign_id, push_status)
        SELECT value, ${campaignId}, 'pending'
          FROM jsonb_array_elements_text(${eligibleJson}::jsonb)
        ON CONFLICT (dealer_lead_id, neodove_campaign_id) DO NOTHING
    `);

    const pending = await db.execute<{ count: string }>(sql`
        SELECT COUNT(*)::text AS count
          FROM neodove_lead_links
         WHERE neodove_campaign_id = ${campaignId}
           AND push_status = 'pending'
           AND dealer_lead_id IN (SELECT value FROM jsonb_array_elements_text(${eligibleJson}::jsonb))
    `);
    const queued = Number(pending[0]?.count ?? 0);

    await db.execute(sql`
        UPDATE neodove_campaigns
           SET status = 'pushing', started_at = COALESCE(started_at, NOW()), updated_at = NOW()
         WHERE id = ${campaignId}
    `);

    after(async () => {
        try {
            await drainSelection(campaignId, endpointRef, eligible.map((l) => l.id));
        } catch (err) {
            console.error("[NeoDove/push-batch] drain failed:", errorMessage(err));
        }
    });

    return successResponse({
        campaignId,
        selected: leadIds.length,
        eligible: eligible.length,
        queued,
        // queued < eligible means those leads were already linked to this
        // campaign by an earlier push — not an error, but the operator should
        // not read `eligible` as "this many were sent now".
        alreadyLinked: eligible.length - queued,
        skipped,
        status: "pushing",
    });
});

/**
 * Push the `pending` links for a specific selection.
 *
 * Scoped to the selected ids rather than to every pending link on the campaign:
 * a selection of five leads must not sweep up thousands of leftovers from an
 * earlier failed audience push that the operator never asked to retry.
 */
async function drainSelection(
    campaignId: string,
    endpointRef: string,
    leadIds: string[],
): Promise<void> {
    const { pushConcurrency, pushDelayMs } = getNeodoveConfig();
    const idsJson = JSON.stringify(leadIds);

    const leads = await db.execute<PushableLead & { link_id: string }>(sql`
        SELECT l.id::text AS link_id,
               dl.id, dl.phone, dl.dealer_name, dl.shop_name, dl.city, dl.state,
               dl.area, dl.pincode, dl.language, dl.source, dl.lead_status,
               dl.interest_level
          FROM neodove_lead_links l
          JOIN dealer_leads dl ON dl.id = l.dealer_lead_id
         WHERE l.neodove_campaign_id = ${campaignId}
           AND l.push_status = 'pending'
           AND l.dealer_lead_id IN (SELECT value FROM jsonb_array_elements_text(${idsJson}::jsonb))
    `);

    let pushed = 0;
    let failed = 0;

    for (let i = 0; i < leads.length; i += pushConcurrency) {
        const batch = leads.slice(i, i + pushConcurrency);

        const results = await Promise.all(
            batch.map(async (lead) => {
                const payload = dealerLeadToNeodove(lead);
                if (!payload) {
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
        `[NeoDove/push-batch] campaign ${campaignId}: ${pushed} pushed, ${failed} failed`,
    );
}
