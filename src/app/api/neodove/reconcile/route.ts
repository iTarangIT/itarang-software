// POST /api/neodove/reconcile — the integrity backstop for inbound sync.
//
// WHY THIS EXISTS AT ALL. NeoDove has no read API. If a webhook is dropped —
// our server restarting, a deploy, a network blip, NeoDove's own retry budget
// expiring — that disposition is gone. It cannot be re-fetched, re-queried or
// polled for. Without reconciliation, "two-way sync" would mean "two-way when
// the network cooperates", and nobody would know when it hadn't.
//
// So: an operator exports the campaign's report from NeoDove's UI (Reports →
// export CSV, the only bulk read NeoDove offers) and posts it here. Every row
// that has no matching lead_touchpoints entry is written with
// sync_method='reconciliation' — a value writeTouchpoint has always supported,
// and this is what it was for.
//
// SAFETY. Reconciliation NEVER drives a status change. A webhook arrives in
// real time with the lead's contemporaneous state; a CSV row is a historical
// record replayed later, possibly out of order, possibly after the lead has
// moved on. Replaying status transitions from it would rewrite the funnel from
// stale data. It writes the touchpoint — the audit fact — and nothing else.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import {
    errorMessage,
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";
import { normalizePhone } from "@/lib/leads/dedupe";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { parseInboundEvent, callStatusFor, remarksFor } from "@/lib/neodove/mapper";
import { attachCallEvidence, recordLeadDisposition } from "@/lib/neodove/inbound";
import { NEODOVE_ADMIN_ROLES } from "@/lib/neodove/roles";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_RECONCILE_ROWS = 20000;

type ReconcileRow = Record<string, string>;

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(NEODOVE_ADMIN_ROLES);

    const form = await req.formData().catch(() => null);
    if (!form) {
        return errorResponse(
            "Send the NeoDove CSV export as multipart/form-data with a `file` field.",
            400,
        );
    }

    const file = form.get("file");
    const campaignId = String(form.get("campaignId") ?? "").trim() || null;
    if (!(file instanceof File)) {
        return errorResponse("No `file` provided.", 400);
    }

    const text = await file.text();
    let rows: ReconcileRow[];
    try {
        const Papa = (await import("papaparse")).default;
        const parsed = Papa.parse<ReconcileRow>(text.trim(), {
            header: true,
            skipEmptyLines: true,
            transformHeader: (h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_"),
        });
        rows = parsed.data;
    } catch (err) {
        return errorResponse(`Could not parse CSV: ${errorMessage(err)}`, 400);
    }

    if (rows.length === 0) return errorResponse("CSV had no data rows.", 400);
    if (rows.length > MAX_RECONCILE_ROWS) {
        return errorResponse(
            `${rows.length} rows exceeds the ${MAX_RECONCILE_ROWS}-row limit. Export a narrower date range.`,
            400,
        );
    }

    const result = {
        rows_read: rows.length,
        already_present: 0,
        backfilled: 0,
        unresolved: 0,
        invalid: 0,
        failed: 0,
    };
    const unresolvedSamples: string[] = [];

    for (const row of rows) {
        // Reuse the inbound parser so a CSV row and a webhook payload are
        // interpreted identically — including the synthetic event-id derivation,
        // which is what lets a CSV row match the webhook it duplicates.
        const event = parseInboundEvent(row);

        const mobile = event.mobile ?? normalizePhone(String(row.mobile ?? row.phone ?? ""));
        if (!mobile) {
            result.invalid++;
            continue;
        }

        try {
            const leads = await db.execute<{ id: string }>(sql`
                SELECT id FROM dealer_leads WHERE phone = ${mobile} LIMIT 1
            `);
            const dealerLeadId = leads[0]?.id;
            if (!dealerLeadId) {
                result.unresolved++;
                if (unresolvedSamples.length < 10) unresolvedSamples.push(mobile);
                continue;
            }

            // Did the webhook for this event already land?
            const existing = await db.execute<{ n: string }>(sql`
                SELECT COUNT(*)::text AS n FROM lead_touchpoints
                 WHERE external_system = 'neodove'
                   AND external_event_id = ${event.externalEventId}
            `);
            if (Number(existing[0]?.n ?? 0) > 0) {
                result.already_present++;
                continue;
            }

            const callStatus = callStatusFor(event);
            const { touchpointId } = await writeTouchpoint({
                dealerLeadId,
                touchpointType: "inside_sales_call",
                performedBy: null,
                performedAt: event.occurredAt ?? new Date(),
                callStatus,
                callDurationSec: event.callDurationSec,
                isEngaged: callStatus === "connected",
                remarks: `${remarksFor(event)} (backfilled from CSV by ${user.email ?? user.id})`,
                externalSystem: "neodove",
                externalEventId: event.externalEventId,
                // The whole point: this row is distinguishable forever from one
                // that arrived live, so drift can be measured over time.
                syncMethod: "reconciliation",
                // Deliberately NO statusChange — see the header note.
            });

            // A NeoDove CSV export carries the agent column, and may carry a
            // recording link. Backfilled rows get the same evidence a live
            // webhook would have left, so a recovered call is not a poorer
            // record than one that arrived on time (E-226).
            await attachCallEvidence(touchpointId, event);
            // Same for the lead's denormalised latest disposition (E-236). The
            // update is guarded on last_disposition_at, so replaying an old CSV
            // export cannot roll a lead's disposition backwards to whatever it
            // was that week.
            await recordLeadDisposition(dealerLeadId, event);

            await db.execute(sql`
                INSERT INTO neodove_sync_events
                    (direction, event_type, neodove_campaign_id, dealer_lead_id,
                     external_event_id, request_payload)
                VALUES ('inbound', 'reconciliation', ${campaignId}, ${dealerLeadId},
                        ${event.externalEventId}, ${JSON.stringify(row)}::jsonb)
                ON CONFLICT (external_event_id)
                    WHERE direction = 'inbound' AND external_event_id IS NOT NULL
                    DO NOTHING
            `);

            result.backfilled++;
        } catch (err) {
            result.failed++;
            console.error("[NeoDove/reconcile] row failed:", errorMessage(err));
        }
    }

    return successResponse({
        ...result,
        // Non-zero backfilled means webhooks ARE being dropped. Worth watching
        // over time rather than treating as a one-off.
        drift: result.backfilled,
        unresolved_samples: unresolvedSamples,
    });
});
