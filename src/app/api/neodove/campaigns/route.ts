// GET  /api/neodove/campaigns — list NeoDove campaigns
// POST /api/neodove/campaigns — create one (draft)
//
// A NeoDove campaign is a mapping, not an engine: NeoDove has no campaign
// creation API, so the campaign must already exist in their UI. What we store
// is the audience we intend to push into it, the env-var name holding its
// Custom Integration endpoint, and the running push/disposition counters.

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

export const runtime = "nodejs";
// `is_wired` reads process.env per request, and on the VPS an endpoint can be
// added with a PM2 restart and no rebuild — a cached response would keep
// reporting a campaign as unwired after it had been wired.
export const dynamic = "force-dynamic";

const createSchema = z.object({
    name: z.string().trim().min(1, "Campaign name is required"),
    neodoveCampaignName: z.string().trim().min(1).optional(),
    // The NAME of an env var, never a URL. Validated against the same shape
    // resolveEndpoint() enforces, so a bad value is caught at create time
    // rather than at push time.
    pushEndpointRef: z
        .string()
        .trim()
        .regex(/^[A-Z][A-Z0-9_]*$/, "Must be an env var NAME, e.g. NEODOVE_PUSH_ENDPOINT_Q3")
        .optional(),
    updateEndpointRef: z
        .string()
        .trim()
        .regex(/^[A-Z][A-Z0-9_]*$/, "Must be an env var NAME")
        .optional(),
    audienceFilter: z.record(z.string(), z.unknown()).optional(),
    // E-225. A descriptive mirror of the NeoDove-side campaign settings.
    // NeoDove has no campaign-creation API, so none of this is applied
    // anywhere — it is recorded so the CRM can show who works the campaign.
    mirrorConfig: mirrorConfigSchema.optional(),
    // E-226. Unlike the mirror, this one IS acted on: it marks the campaign the
    // per-lead "Call now" push targets.
    isPriorityDial: z.boolean().optional(),
});

function makeCampaignId(): string {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const rand = Math.floor(Math.random() * 900 + 100);
    return `NDC-${stamp}-${rand}`;
}

export const GET = withErrorHandler(async () => {
    await requireRole(NEODOVE_ADMIN_ROLES);

    const rows = await db.execute(sql`
        SELECT c.id, c.name, c.neodove_campaign_name, c.status,
               c.total_pushed, c.push_failed,
               -- DERIVED, not the c.dispositions_received counter. That counter
               -- is incremented by matching neodove_campaign_name against the
               -- name in the inbound payload, which matches nothing whenever the
               -- NeoDove campaign is named differently from the CRM one — the
               -- normal case, since one Custom Integration serves several CRM
               -- campaigns. It sat at 0 on campaigns with dispositions on file,
               -- and the detail page (which counts the rows) disagreed with this
               -- list. Excludes neodove_dial_request for the same reason the
               -- detail route does: a hand-off request is not a call.
               (SELECT COUNT(*)
                  FROM lead_touchpoints t
                  JOIN neodove_lead_links l ON l.dealer_lead_id = t.dealer_lead_id
                 WHERE l.neodove_campaign_id = c.id
                   AND t.external_system = 'neodove'
                   AND t.touchpoint_type <> 'neodove_dial_request'
               )::int AS dispositions_received,
               -- Distinct leads delivered. total_pushed counts ATTEMPTS (the
               -- link upsert is ON CONFLICT DO UPDATE), so a re-push inflates it
               -- without adding a lead.
               (SELECT COUNT(*) FROM neodove_lead_links l
                 WHERE l.neodove_campaign_id = c.id AND l.push_status = 'pushed'
               )::int AS delivered,
               c.audience_filter, c.started_at, c.completed_at, c.created_at,
               u.name AS created_by_name,
               -- push_endpoint_ref is the env var NAME, safe to show: it tells
               -- an admin which campaign is wired without exposing the URL,
               -- which is the actual credential.
               c.push_endpoint_ref,
               -- Read through to_jsonb rather than naming the column: a missing
               -- column fails the statement at PARSE time, which would take the
               -- whole campaigns list down on any DB without E-225. Resolved at
               -- runtime instead, yielding NULL when the column is absent.
               to_jsonb(c) -> 'mirror_config' AS mirror_config,
               -- E-226, same treatment: NULL where the migration is unapplied,
               -- which the UI reads as "not the priority destination".
               (to_jsonb(c) ->> 'is_priority_dial') = 'true' AS is_priority_dial
          FROM neodove_campaigns c
          LEFT JOIN users u ON u.id = c.created_by
         ORDER BY c.created_at DESC
         LIMIT 100
    `);

    // `is_wired` is computed HERE, not in SQL. It used to be
    // `push_endpoint_ref IS NOT NULL`, which answers a different question: the
    // database knows a ref was typed, only the server knows whether that env var
    // is actually populated. A campaign pointing at an unset var was therefore
    // offered as a valid destination in the Send-to-NeoDove dropdown and failed
    // at push time, far from the mistake.
    //
    // `endpoint_shared_with` names the other campaigns pointing at the SAME env
    // var. That is not a warning about tidiness: the URL *is* the routing —
    // nothing in the push body names a campaign — so leads sent to either
    // campaign land in the same place in NeoDove, and the destination dropdown
    // would otherwise present a choice that isn't one.
    const list = rows as unknown as {
        id: string;
        name: string;
        push_endpoint_ref: string | null;
    }[];

    const byRef = new Map<string, string[]>();
    for (const c of list) {
        if (!c.push_endpoint_ref) continue;
        byRef.set(c.push_endpoint_ref, [
            ...(byRef.get(c.push_endpoint_ref) ?? []),
            c.name,
        ]);
    }

    return successResponse(
        list.map((c) => ({
            ...c,
            is_wired: isEndpointWired(c.push_endpoint_ref),
            endpoint_shared_with: c.push_endpoint_ref
                ? (byRef.get(c.push_endpoint_ref) ?? []).filter((n) => n !== c.name)
                : [],
        })),
    );
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(NEODOVE_ADMIN_ROLES);

    const body = await req.json().catch(() => ({}));
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
        return errorResponse(
            parsed.error.issues.map((i) => i.message).join("; "),
            400,
        );
    }
    const data = parsed.data;
    const id = makeCampaignId();

    // mirror_config is named only when the caller actually sent one. Naming a
    // column that does not exist fails at PARSE time, so an unconditional
    // reference would break campaign creation outright on any DB where E-225
    // has not been applied — and E-225 is not applied everywhere. This way the
    // mirror degrades to "cannot be recorded" instead of taking the form down.
    const mirror = data.mirrorConfig;
    // is_priority_dial (E-226) is named on the same conditional terms as
    // mirror_config, and for the same reason. Only `true` is worth naming:
    // `false` is the column default, so sending it would buy nothing and cost
    // campaign creation on any DB without E-226.
    const priority = data.isPriorityDial === true;

    // Exactly one campaign may be the priority-dial destination — the partial
    // unique index would otherwise refuse this INSERT outright. Clearing the
    // incumbent first makes ticking the box on a new campaign do what the form
    // says it does (move the flag) instead of erroring on a constraint the
    // operator never sees.
    if (priority) {
        await db.execute(sql`
            UPDATE neodove_campaigns SET is_priority_dial = false, updated_at = NOW()
             WHERE is_priority_dial
        `);
    }

    await db.execute(sql`
        INSERT INTO neodove_campaigns
            (id, name, neodove_campaign_name, push_endpoint_ref,
             update_endpoint_ref, audience_filter, status, created_by
             ${mirror ? sql`, mirror_config` : sql``}
             ${priority ? sql`, is_priority_dial` : sql``})
        VALUES (${id}, ${data.name}, ${data.neodoveCampaignName ?? null},
                ${data.pushEndpointRef ?? null}, ${data.updateEndpointRef ?? null},
                ${data.audienceFilter ? JSON.stringify(data.audienceFilter) : null}::jsonb,
                'draft', ${user.id}
                ${mirror ? sql`, ${JSON.stringify(mirror)}::jsonb` : sql``}
                ${priority ? sql`, true` : sql``})
    `);

    return successResponse({ id });
});
