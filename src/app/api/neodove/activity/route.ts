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
    /** Campaign name as NeoDove sent it — present even when nothing links here. */
    external_campaign_name: string | null;
    dealer_lead_id: string | null;
    dealer_name: string | null;
    phone: string | null;
    /** Dealer as NeoDove named them — present even when nothing links here. */
    payload_name: string | null;
    payload_mobile: string | null;
    payload_lead_id: string | null;
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

    // SEARCH, MATCHED AGAINST BOTH SIDES OF THE ROW.
    //
    // A ledger row's identity lives in two places — the joined dealer_lead, and
    // the raw payload NeoDove sent — and the whole reason this screen has a LEAD
    // column fallback is that the two do not always agree. Searching only the
    // joined lead would therefore be unable to find precisely the rows that are
    // hardest to find by eye: the ones that never linked. So every predicate
    // below is applied to the lead AND to the payload.
    //
    // The number is compared DIGITS-ONLY, on both sides. dealer_leads.phone is
    // stored both bare and +91-prefixed (2396 vs 321 rows on database-1), and
    // NeoDove sends the bare national number — so a literal comparison of what
    // someone types would miss most of the table. Stripping non-digits from both
    // and matching a substring means "9755502969", "+91 97555 02969" and the
    // last four digits all find the same lead.
    const q = (searchParams.get("q") ?? "").trim();
    const digits = q.replace(/\D/g, "");
    // Three digits before a number search engages: fewer matches half the ledger
    // and reads as a broken filter rather than a broad one.
    const phoneNeedle = digits.length >= 3 ? `%${digits}%` : null;
    // Names are searched too — someone reading this screen has a dealer in mind,
    // not a number, about as often as the reverse.
    const nameNeedle = q.length >= 2 ? `%${q}%` : null;
    const searching = phoneNeedle !== null || nameNeedle !== null;

    const rows = await db.execute<ActivityRow>(sql`
        SELECT e.id::text AS id,
               e.direction,
               e.event_type,
               e.neodove_campaign_id,
               c.name AS campaign_name,
               -- The campaign as NEODOVE names it, straight from the payload.
               -- Most inbound events come from campaigns that exist only on
               -- their side — lists uploaded into NeoDove and never pushed from
               -- here — so there is no neodove_campaigns row to join to, and
               -- the column rendered as a dash even though the payload said
               -- exactly which campaign the call belonged to. Two paths because
               -- some deliveries nest the body under a 'data' key.
               COALESCE(
                   e.request_payload ->> 'campaign_name',
                   e.request_payload -> 'data' ->> 'campaign_name'
               ) AS external_campaign_name,
               e.dealer_lead_id,
               dl.dealer_name,
               dl.phone,
               -- WHO THE EVENT WAS ABOUT, straight from the payload.
               --
               -- The join above only fires when the event resolved to one of our
               -- leads, and some inbound events never can: nine dispositions from
               -- the "Kapil Daily Visit" campaign carry 9-digit mobiles
               -- (725888911), which normalizePhone rejects, so there is nothing to
               -- match on and nothing legitimate to create. Those rows rendered a
               -- bare dash under LEAD, which reads as "no data" when in fact the
               -- payload names the dealer and the number the agent dialled.
               --
               -- This is a DISPLAY fallback and nothing more — it is NOT a link to
               -- a CRM lead, and the screen marks it as such. Same two paths as
               -- the campaign name above, for the nested-body deliveries.
               COALESCE(
                   e.request_payload ->> 'name',
                   e.request_payload -> 'data' ->> 'name'
               ) AS payload_name,
               COALESCE(
                   e.request_payload ->> 'mobile',
                   e.request_payload -> 'data' ->> 'mobile',
                   e.request_payload ->> 'phone',
                   e.request_payload -> 'data' ->> 'phone'
               ) AS payload_mobile,
               -- Last resort. One captured LEAD_CREATE (2026-08-03) carries
               -- neither a name nor a mobile — only NeoDove's own lead id. That
               -- id is still an identity: it is what you paste into their UI to
               -- find the record, which is the only way to learn what the event
               -- was about.
               COALESCE(
                   e.request_payload ->> 'lead_id',
                   e.request_payload -> 'data' ->> 'lead_id'
               ) AS payload_lead_id,
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
           AND (${!searching} OR (
                   (${phoneNeedle !== null} AND (
                        regexp_replace(COALESCE(dl.phone, ''), '[^0-9]', '', 'g')
                            LIKE ${phoneNeedle}
                     OR regexp_replace(
                            COALESCE(e.request_payload ->> 'mobile',
                                     e.request_payload -> 'data' ->> 'mobile',
                                     e.request_payload ->> 'phone',
                                     e.request_payload -> 'data' ->> 'phone',
                                     ''),
                            '[^0-9]', '', 'g') LIKE ${phoneNeedle}))
                OR (${nameNeedle !== null} AND (
                        dl.dealer_name ILIKE ${nameNeedle}
                     OR COALESCE(e.request_payload ->> 'name',
                                 e.request_payload -> 'data' ->> 'name')
                            ILIKE ${nameNeedle}
                     OR e.dealer_lead_id ILIKE ${nameNeedle}))
               ))
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
