// GET /api/neodove/campaigns/[id] — detail for one NeoDove campaign.
//
// Deliberately NOT the AI-dialer detail shape. There are no transcripts, no
// per-call cost and no dial queue here — NeoDove owns the calling. What this
// surfaces instead is the two things that can actually go wrong with a
// vendor integration you cannot query: pushes that failed, and dispositions
// that never came back.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import {
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";
import { NEODOVE_ADMIN_ROLES } from "@/lib/neodove/roles";
import { isEndpointWired } from "@/lib/neodove/config";
import { mirrorConfigSchema } from "@/lib/neodove/types";
import { resolveAudience, type AudienceSelection } from "@/lib/ai-dialer/audience";

export const runtime = "nodejs";
// `is_wired` reads process.env per request — see the campaigns list route.
export const dynamic = "force-dynamic";

// A priority-dial hand-off is NOT a call — see the header of
// src/lib/lifecycle/touchpointTypes.ts, which says so explicitly and warns that
// counting it as one inflates every call-volume and connect-rate figure. It was
// being counted here: "Call outcomes" filtered only on external_system, so five
// Call now clicks rendered as five unclassified call outcomes. Excluded by type
// rather than by sync_method because a dial request and a genuinely
// manually-logged call would both be sync_method='manual'.
const CALL_TOUCHPOINTS = sql`t.touchpoint_type <> 'neodove_dial_request'`;

export const GET = withErrorHandler(
    async (_req: Request, context: { params: Promise<{ id: string }> }) => {
        await requireRole(NEODOVE_ADMIN_ROLES);
        const { id } = await context.params;

        const campaigns = await db.execute(sql`
            SELECT c.id, c.name, c.neodove_campaign_name, c.status,
                   c.push_endpoint_ref, c.audience_filter,
                   -- Read through to_jsonb rather than naming the column: a
                   -- missing relation OR column fails a statement at PARSE
                   -- time, so a direct c.mirror_config reference would take
                   -- this whole route down on any DB without E-225 applied.
                   -- The jsonb lookup resolves at runtime and yields NULL.
                   -- (No backticks in this comment -- the whole statement is a
                   -- JS template literal and one would terminate it.)
                   to_jsonb(c) -> 'mirror_config' AS mirror_config,
                   -- E-226, same treatment for the same reason.
                   (to_jsonb(c) ->> 'is_priority_dial') = 'true' AS is_priority_dial,
                   c.total_pushed, c.push_failed, c.dispositions_received,
                   c.started_at, c.completed_at, c.created_at,
                   u.name AS created_by_name
              FROM neodove_campaigns c
              LEFT JOIN users u ON u.id = c.created_by
             WHERE c.id = ${id} LIMIT 1
        `);
        if (!campaigns[0]) return errorResponse("Campaign not found", 404);

        const pushBreakdown = await db.execute<{
            push_status: string;
            count: string;
        }>(sql`
            SELECT push_status, COUNT(*)::text AS count
              FROM neodove_lead_links
             WHERE neodove_campaign_id = ${id}
             GROUP BY push_status
        `);

        // Dispositions this campaign actually delivered, by call outcome.
        const dispositions = await db.execute<{
            call_status: string | null;
            sync_method: string | null;
            count: string;
        }>(sql`
            SELECT t.call_status, t.sync_method, COUNT(*)::text AS count
              FROM lead_touchpoints t
              JOIN neodove_lead_links l ON l.dealer_lead_id = t.dealer_lead_id
             WHERE l.neodove_campaign_id = ${id}
               AND t.external_system = 'neodove'
               AND ${CALL_TOUCHPOINTS}
             GROUP BY t.call_status, t.sync_method
        `);

        // Priority-dial hand-offs. Counted and shown SEPARATELY rather than
        // dropped: "we handed 5 leads over and 3 calls came back" is the useful
        // reading, and it is invisible if the requests are either merged into
        // call outcomes or omitted entirely.
        const dialRequests = await db.execute<{ count: string }>(sql`
            SELECT COUNT(*)::text AS count
              FROM lead_touchpoints t
              JOIN neodove_lead_links l ON l.dealer_lead_id = t.dealer_lead_id
             WHERE l.neodove_campaign_id = ${id}
               AND t.external_system = 'neodove'
               AND t.touchpoint_type = 'neodove_dial_request'
        `);

        // DRIFT: touchpoints that had to be backfilled from a CSV export
        // because their webhook never arrived. Non-zero means deliveries are
        // being lost and reconciliation is load-bearing, not optional.
        const drift = await db.execute<{ backfilled: string; live: string }>(sql`
            SELECT
              COUNT(*) FILTER (WHERE t.sync_method = 'reconciliation')::text AS backfilled,
              COUNT(*) FILTER (WHERE t.sync_method = 'api')::text AS live
              FROM lead_touchpoints t
              JOIN neodove_lead_links l ON l.dealer_lead_id = t.dealer_lead_id
             WHERE l.neodove_campaign_id = ${id}
               AND t.external_system = 'neodove'
               AND ${CALL_TOUCHPOINTS}
        `);

        const recentErrors = await db.execute(sql`
            SELECT id, direction, event_type, dealer_lead_id, http_status,
                   error, attempts, created_at
              FROM neodove_sync_events
             WHERE neodove_campaign_id = ${id} AND error IS NOT NULL
             ORDER BY created_at DESC
             LIMIT 25
        `);

        const failedLeads = await db.execute(sql`
            SELECT l.dealer_lead_id, l.push_error, l.push_status,
                   dl.dealer_name, dl.shop_name, dl.phone, dl.city
              FROM neodove_lead_links l
              JOIN dealer_leads dl ON dl.id = l.dealer_lead_id
             WHERE l.neodove_campaign_id = ${id}
               AND l.push_status IN ('failed', 'skipped_excluded')
             ORDER BY l.created_at DESC
             LIMIT 50
        `);

        // AUDIENCE: how many leads this campaign's saved filter currently
        // targets. The card used to show the number of rows in
        // neodove_lead_links, which is "leads already pushed here" — a number
        // that starts at 0, grows as you push, and can never answer the
        // question the label asks. Resolved through the same function the
        // Preview audience button uses so the card and the preview cannot
        // disagree.
        //
        // Best-effort: this is a decorative count on a page whose real job is
        // showing delivery failures, and resolveAudience touches several tables.
        // If it throws, the page still renders with the audience unknown.
        let audienceCount: number | null = null;
        try {
            const filter = (campaigns[0] as { audience_filter?: unknown })
                .audience_filter;
            const audience = await resolveAudience(
                (filter ?? {}) as AudienceSelection,
            );
            audienceCount = audience.queueIds.length;
        } catch (err) {
            console.error("[NeoDove/campaign] audience resolve failed:", err);
        }

        const pushedLeads = pushBreakdown
            .filter((r) => r.push_status === "pushed")
            .reduce((a, r) => a + Number(r.count), 0);

        // "Wired" means the env var this campaign points at is actually
        // populated on THIS server, not merely that a ref was typed. The page
        // used to infer it from `push_endpoint_ref` being non-null, so a
        // campaign referencing an unset variable rendered as fully configured
        // and only failed when someone pushed to it.
        const endpointRef = (campaigns[0] as { push_endpoint_ref?: string | null })
            .push_endpoint_ref;
        const isWired = isEndpointWired(endpointRef);

        // Other campaigns pointing at the SAME env var. The URL is the routing —
        // no campaign identifier travels in the push body — so those campaigns
        // deliver into the same NeoDove campaign as this one, and picking
        // between them in the destination dropdown changes nothing.
        const sharedEndpoint = endpointRef
            ? await db.execute<{ id: string; name: string }>(sql`
                  SELECT id, name FROM neodove_campaigns
                   WHERE push_endpoint_ref = ${endpointRef} AND id <> ${id}
                   ORDER BY created_at DESC
                   LIMIT 10
              `)
            : [];

        return successResponse({
            campaign: {
                ...(campaigns[0] as Record<string, unknown>),
                is_wired: isWired,
                endpoint_shared_with: sharedEndpoint,
            },
            pushBreakdown,
            dispositions,
            audienceCount,
            // DISTINCT LEADS delivered, not push attempts. `total_pushed` counts
            // attempts — the link upsert is ON CONFLICT DO UPDATE, so re-pushing
            // a lead already in this campaign bumps the counter without adding a
            // row. Both were labelled "Delivered" on the same screen, showing 11
            // and 8 for the same campaign.
            delivered: pushedLeads,
            pushAttempts: Number(
                (campaigns[0] as { total_pushed?: number }).total_pushed ?? 0,
            ),
            // Derived from the touchpoints that exist, NOT from the
            // dispositions_received counter. That counter is incremented by
            // matching neodove_campaign_name against the name in the inbound
            // payload, which matches nothing when the NeoDove campaign is named
            // differently from the CRM one (the normal case — one Custom
            // Integration serves several CRM campaigns) and would match several
            // rows if two CRM campaigns shared a name. It reads 0 here while
            // three dispositions are on file.
            dispositionsBack: dispositions.reduce(
                (a, r) => a + Number(r.count),
                0,
            ),
            dialRequests: Number(dialRequests[0]?.count ?? 0),
            drift: {
                backfilled: Number(drift[0]?.backfilled ?? 0),
                live: Number(drift[0]?.live ?? 0),
            },
            recentErrors,
            failedLeads,
        });
    },
);

// PATCH /api/neodove/campaigns/[id] — edit a campaign's CONFIGURATION.
//
// Without this a campaign created without a push endpoint was unfixable: the
// endpoint could only ever be set at creation, so "not wired" was permanent
// short of hand-written SQL, and the only remedy was to delete and re-create.
// Wiring an endpoint after the fact is the normal case, not an edge one — the
// Custom Integration in NeoDove is often created after the campaign here.
//
// Counters (total_pushed / push_failed / dispositions_received) are NOT
// editable. They are the ledger's running totals and the only record of what
// was actually sent; letting a UI overwrite them would destroy the one number
// reconciliation is diffed against.
const patchSchema = z.object({
    name: z.string().trim().min(1).optional(),
    // Nullable, not just optional: clearing a wrong NeoDove campaign name has
    // to be expressible, and `undefined` already means "leave unchanged".
    neodoveCampaignName: z.string().trim().min(1).nullable().optional(),
    pushEndpointRef: z
        .string()
        .trim()
        .regex(/^[A-Z][A-Z0-9_]*$/, "Must be an env var NAME, e.g. NEODOVE_PUSH_ENDPOINT_Q3")
        .nullable()
        .optional(),
    updateEndpointRef: z
        .string()
        .trim()
        .regex(/^[A-Z][A-Z0-9_]*$/, "Must be an env var NAME")
        .nullable()
        .optional(),
    audienceFilter: z.record(z.string(), z.unknown()).optional(),
    // E-225 mirror. Nullable so a recorded-then-wrong mirror can be cleared
    // outright rather than left as a stale half-truth about NeoDove's setup.
    mirrorConfig: mirrorConfigSchema.nullable().optional(),
    // E-226. Absent = leave alone, which is what keeps every existing caller
    // (and every DB without E-226) working untouched.
    isPriorityDial: z.boolean().optional(),
});

export const PATCH = withErrorHandler(
    async (req: Request, context: { params: Promise<{ id: string }> }) => {
        await requireRole(NEODOVE_ADMIN_ROLES);
        const { id } = await context.params;

        const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
        if (!parsed.success) {
            return errorResponse(
                parsed.error.issues.map((i) => i.message).join("; "),
                400,
            );
        }
        const d = parsed.data;
        if (Object.keys(d).length === 0) {
            return errorResponse("Nothing to update.", 400);
        }

        const existing = await db.execute<{ id: string }>(sql`
            SELECT id FROM neodove_campaigns WHERE id = ${id} LIMIT 1
        `);
        if (!existing[0]) return errorResponse("Campaign not found", 404);

        // Built field-by-field rather than with COALESCE(${v}, col): that idiom
        // cannot express "set this to NULL", which is exactly what clearing a
        // wrong endpoint ref requires. `undefined` = key absent = leave alone;
        // an explicit null = clear it.
        const sets = [];
        if (d.name !== undefined) sets.push(sql`name = ${d.name}`);
        if (d.neodoveCampaignName !== undefined) {
            sets.push(sql`neodove_campaign_name = ${d.neodoveCampaignName}`);
        }
        if (d.pushEndpointRef !== undefined) {
            sets.push(sql`push_endpoint_ref = ${d.pushEndpointRef}`);
        }
        if (d.updateEndpointRef !== undefined) {
            sets.push(sql`update_endpoint_ref = ${d.updateEndpointRef}`);
        }
        if (d.audienceFilter !== undefined) {
            sets.push(
                sql`audience_filter = ${JSON.stringify(d.audienceFilter)}::jsonb`,
            );
        }
        if (d.mirrorConfig !== undefined) {
            sets.push(
                sql`mirror_config = ${d.mirrorConfig === null ? null : JSON.stringify(d.mirrorConfig)}::jsonb`,
            );
        }
        if (d.isPriorityDial !== undefined) {
            // At most one priority-dial campaign, enforced by a partial unique
            // index. Clearing the incumbent FIRST turns "tick the box" into a
            // move rather than a constraint violation the operator cannot act
            // on. Scoped to other campaigns so re-saving the current one with
            // the box already ticked is a no-op, not a flag that clears itself.
            if (d.isPriorityDial) {
                await db.execute(sql`
                    UPDATE neodove_campaigns
                       SET is_priority_dial = false, updated_at = NOW()
                     WHERE is_priority_dial AND id <> ${id}
                `);
            }
            sets.push(sql`is_priority_dial = ${d.isPriorityDial}`);
        }
        sets.push(sql`updated_at = NOW()`);

        await db.execute(sql`
            UPDATE neodove_campaigns
               SET ${sql.join(sets, sql`, `)}
             WHERE id = ${id}
        `);

        return successResponse({ id });
    },
);
