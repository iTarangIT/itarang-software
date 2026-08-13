// Rebuild a lead's NeoDove touchpoints from the neodove_sync_events ledger.
//
//   node --import tsx --env-file=.env.local \
//     scripts/restore-lead-touchpoints-from-ledger.ts <dealer_lead_id>
//
// WHY THIS IS POSSIBLE AT ALL. neodove_sync_events keeps the FULL raw payload of
// every inbound event (webhook body or CSV row) precisely because NeoDove has no
// read API and a lost disposition is otherwise unrecoverable. That ledger is
// therefore a genuine source of truth, not a debug log — and this script is the
// thing it was kept for.
//
// It replays each stored payload through the SAME code the reconcile route uses
// (parseInboundEvent → writeTouchpoint → attachCallEvidence →
// recordLeadDisposition), so a rebuilt touchpoint is byte-for-byte what the
// original was, and re-running is a no-op: the external_event_id guard skips any
// touchpoint that already exists.
//
// It deliberately does NOT write a statusChange, matching reconcile's rule that
// a historical record must never drive a lifecycle transition.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { parseInboundEvent, callStatusFor, remarksFor } from "@/lib/neodove/mapper";
import { attachCallEvidence, recordLeadDisposition } from "@/lib/neodove/inbound";

const leadId = process.argv[2];
if (!leadId) {
    console.error("Usage: restore-lead-touchpoints-from-ledger.ts <dealer_lead_id>");
    process.exit(1);
}

async function main() {
    const events = await db.execute<{
        id: string;
        event_type: string | null;
        external_event_id: string | null;
        request_payload: Record<string, unknown> | null;
        created_at: string;
    }>(sql`
        SELECT id::text, event_type, external_event_id, request_payload, created_at::text
          FROM neodove_sync_events
         WHERE dealer_lead_id = ${leadId} AND direction = 'inbound'
         ORDER BY created_at ASC`);

    console.log(`Lead ${leadId}: ${events.length} stored inbound event(s)`);

    let restored = 0;
    let skipped = 0;

    for (const ev of events) {
        if (!ev.request_payload) {
            skipped++;
            continue;
        }
        const event = parseInboundEvent(ev.request_payload);

        const existing = await db.execute<{ n: string }>(sql`
            SELECT COUNT(*)::text AS n FROM lead_touchpoints
             WHERE external_system = 'neodove'
               AND external_event_id = ${event.externalEventId}`);
        if (Number(existing[0]?.n ?? 0) > 0) {
            console.log(`  skip  ${event.externalEventId} — already present`);
            skipped++;
            continue;
        }

        const callStatus = callStatusFor(event);
        const { touchpointId } = await writeTouchpoint({
            dealerLeadId: leadId,
            touchpointType: "inside_sales_call",
            performedBy: null,
            performedAt: event.occurredAt ?? new Date(ev.created_at),
            callStatus,
            callDurationSec: event.callDurationSec,
            isEngaged: callStatus === "connected",
            remarks: `${remarksFor(event)} (restored from sync ledger)`,
            externalSystem: "neodove",
            externalEventId: event.externalEventId,
            syncMethod: "reconciliation",
        });
        await attachCallEvidence(touchpointId, event);
        await recordLeadDisposition(leadId, event);

        console.log(`  OK    ${event.externalEventId} → ${touchpointId} (${callStatus ?? "no status"})`);
        restored++;
    }

    const now = await db.execute<{ n: string }>(sql`
        SELECT COUNT(*)::text AS n FROM lead_touchpoints WHERE dealer_lead_id = ${leadId}`);
    console.log(`\nRestored ${restored}, skipped ${skipped}. Touchpoints now: ${now[0]?.n}`);
    process.exit(0);
}

main().catch((e) => {
    console.error("ERROR:", e);
    process.exit(1);
});
