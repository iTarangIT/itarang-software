// GET /api/neodove/activity — the whole NeoDove sync ledger, across campaigns.
//
// neodove_sync_events is a RECONCILIATION LEDGER, not a debug log (see E-224).
// Because NeoDove cannot be queried, this table is the only record that a push
// happened, and the only thing a CSV export can be diffed against. Until this
// route existed it was visible only as "recent errors" on one campaign's detail
// page, which is exactly the wrong shape for the question people actually ask:
// "is the integration healthy right now, and if not, since when?"
//
// Filters are deliberately few. direction + errorsOnly cover triage; anything
// more specific belongs on a campaign page where the context is already narrow.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { NEODOVE_ADMIN_ROLES } from "@/lib/neodove/roles";

export const runtime = "nodejs";

export type ActivityRow = {
    id: string;
    direction: string;
    event_type: string | null;
    neodove_campaign_id: string | null;
    campaign_name: string | null;
    dealer_lead_id: string | null;
    dealer_name: string | null;
    phone: string | null;
    external_event_id: string | null;
    http_status: number | null;
    error: string | null;
    attempts: number;
    created_at: string;
    request_payload: unknown;
    response_payload: unknown;
};

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(NEODOVE_ADMIN_ROLES);

    const { searchParams } = new URL(req.url);
    const page = Math.max(1, Number(searchParams.get("page") || 1));
    const limit = Math.min(200, Math.max(1, Number(searchParams.get("limit") || 50)));
    const offset = (page - 1) * limit;

    const direction = searchParams.get("direction");
    const wantOutbound = direction !== "inbound";
    const wantInbound = direction !== "outbound";
    const errorsOnly = searchParams.get("errorsOnly") === "true";
    const campaignId = searchParams.get("campaignId");

    const rows = await db.execute<ActivityRow>(sql`
        SELECT e.id::text AS id,
               e.direction,
               e.event_type,
               e.neodove_campaign_id,
               c.name AS campaign_name,
               e.dealer_lead_id,
               dl.dealer_name,
               dl.phone,
               e.external_event_id,
               e.http_status,
               e.error,
               e.attempts,
               e.created_at,
               -- The captured payloads. Inbound rows carry NeoDove's verbatim
               -- webhook body, which is the only way to learn the real event
               -- shape: parseInboundEvent() is an educated guess until one of
               -- these has been read (docs/neodove-contract.md §4).
               --
               -- The 'endpoint' key is stripped from OUTBOUND rows before it
               -- ever leaves the server. It holds redactEndpoint()'s output,
               -- which keeps the origin — and the origin is
               -- https://<account-uuid>.neodove.com, i.e. half of the only
               -- credential NeoDove issues. Redacted enough for a server log is
               -- not the same as safe to hand to a browser.
               CASE WHEN e.direction = 'outbound'
                    THEN e.request_payload - 'endpoint'
                    ELSE e.request_payload
               END AS request_payload,
               e.response_payload
          FROM neodove_sync_events e
          LEFT JOIN neodove_campaigns c ON c.id = e.neodove_campaign_id
          -- Soft join: dealer_lead_id is not an FK (lead rows outlive campaign
          -- bookkeeping), so a missing lead must not drop the ledger row.
          LEFT JOIN dealer_leads dl ON dl.id = e.dealer_lead_id
         WHERE (
                 (e.direction = 'outbound' AND ${wantOutbound})
              OR (e.direction = 'inbound'  AND ${wantInbound})
               )
           AND (${!errorsOnly} OR e.error IS NOT NULL)
           AND (${campaignId === null} OR e.neodove_campaign_id = ${campaignId})
         ORDER BY e.created_at DESC
         LIMIT ${limit} OFFSET ${offset}
    `);

    // Health summary over the last 24h — the "is it working right now" number.
    // Counted separately from the page above so paging never changes it.
    const summary = await db.execute<{
        outbound: string;
        inbound: string;
        errors: string;
        backfilled: string;
    }>(sql`
        SELECT
          COUNT(*) FILTER (WHERE direction = 'outbound')::text AS outbound,
          COUNT(*) FILTER (WHERE direction = 'inbound')::text  AS inbound,
          COUNT(*) FILTER (WHERE error IS NOT NULL)::text      AS errors,
          COUNT(*) FILTER (WHERE event_type = 'reconciliation')::text AS backfilled
        FROM neodove_sync_events
        WHERE created_at > NOW() - INTERVAL '24 hours'
    `);

    return successResponse({
        rows,
        page,
        summary: {
            outbound: Number(summary[0]?.outbound ?? 0),
            inbound: Number(summary[0]?.inbound ?? 0),
            errors: Number(summary[0]?.errors ?? 0),
            backfilled: Number(summary[0]?.backfilled ?? 0),
        },
    });
});
