// Backfill dealer_lead_id / neodove_campaign_id on historical inbound rows of
// neodove_sync_events.
//
//   node --import tsx --env-file=.env.local scripts/backfill-neodove-event-context.ts [--apply]
//
// WHY THESE ARE EMPTY. The webhook CLAIMS its ledger row before doing any work —
// it has to, because inserting external_event_id under the partial unique index
// is what gives replay protection, and that must happen before the handler runs
// in after(). At claim time no lead has been resolved, so every inbound row was
// written with dealer_lead_id = NULL and nothing ever went back to fill it in.
// Sync Activity therefore showed a dash under LEAD and CAMPAIGN for every
// disposition NeoDove has ever sent, even though the payload named both.
//
// handleNeodoveEvent now stamps this for new events. This script repairs the
// history, which it can do losslessly because the ledger keeps the verbatim
// payload of every inbound event.
//
// It NEVER creates a lead. A disposition that auto-created one at the time will
// match by phone now; anything still unmatched stays NULL, because inventing a
// dealer months after the call is not a backfill.
//
// Dry-run by default. Pass --apply to write.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { parseInboundEvent } from "@/lib/neodove/mapper";
import { resolveInboundLead } from "@/lib/neodove/inbound";

const APPLY = process.argv.includes("--apply");

async function main() {
    const rows = await db.execute<{
        id: string;
        event_type: string | null;
        external_event_id: string | null;
        request_payload: unknown;
        has_lead: boolean;
        has_campaign: boolean;
        created_at: string;
    }>(sql`
        SELECT id::text, event_type, external_event_id, request_payload,
               (dealer_lead_id IS NOT NULL) AS has_lead,
               (neodove_campaign_id IS NOT NULL) AS has_campaign,
               created_at::text
          FROM neodove_sync_events
         WHERE direction = 'inbound'
           AND (dealer_lead_id IS NULL OR neodove_campaign_id IS NULL)
         ORDER BY created_at ASC`);

    console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${rows.length} inbound row(s) missing lead and/or campaign\n`);

    let leadFixed = 0;
    let campFixed = 0;
    let noMatch = 0;

    for (const r of rows) {
        if (!r.request_payload) {
            noMatch++;
            continue;
        }
        const event = parseInboundEvent(r.request_payload);

        const leadId = r.has_lead ? null : await resolveInboundLead(event);

        let campaignId: string | null = null;
        if (!r.has_campaign && event.campaignName) {
            const c = await db.execute<{ id: string }>(sql`
                SELECT id FROM neodove_campaigns
                 WHERE neodove_campaign_name = ${event.campaignName} LIMIT 1`);
            campaignId = c[0]?.id ?? null;
        }

        if (!leadId && !campaignId) {
            noMatch++;
            continue;
        }
        if (leadId) leadFixed++;
        if (campaignId) campFixed++;

        console.log(
            `  ${r.created_at.slice(0, 16)} ${r.event_type ?? "-"} → lead=${leadId ?? "(kept)"} campaign=${campaignId ?? "(none in CRM)"}${event.campaignName ? ` [NeoDove: ${event.campaignName}]` : ""}`,
        );

        if (APPLY) {
            await db.execute(sql`
                UPDATE neodove_sync_events
                   SET dealer_lead_id = COALESCE(dealer_lead_id, ${leadId}),
                       neodove_campaign_id = COALESCE(neodove_campaign_id, ${campaignId})
                 WHERE id = ${r.id}::uuid`);
        }
    }

    console.log(
        `\n${APPLY ? "Updated" : "Would update"}: ${leadFixed} lead link(s), ${campFixed} campaign link(s). ${noMatch} row(s) left as-is.`,
    );
    if (!APPLY && (leadFixed || campFixed)) {
        console.log("Re-run with --apply to write.");
    }
    process.exit(0);
}

main().catch((e) => {
    console.error("ERROR:", e);
    process.exit(1);
});
