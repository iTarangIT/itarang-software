// Replay inbound NeoDove events that were received but never turned into a
// touchpoint.
//
// WHY THIS IS SAFE TO RUN, AND TO RE-RUN. The webhook route persists every
// delivery into neodove_sync_events BEFORE parsing, so an event that failed to
// resolve is not lost — only unprocessed. This walks those rows back through
// the REAL handler (no reimplemented logic), and both replay guards still
// apply: lead_touchpoints_external_uniq (E-113) means a second run writes zero
// duplicate touchpoints.
//
// WHEN YOU NEED IT. Any change to lead resolution creates a backlog of events
// that would resolve now but didn't then. That has happened twice already:
//   - 2026-08-04, the phone-format fix (exact compare missed ~88% of leads)
//   - 2026-08-04, auto-create on unmatched disposition (telecallers work
//     campaigns whose lists were never pushed from the CRM, so no LEAD_CREATE
//     ever arrives for them and 16/16 dispositions were being discarded)
//
// Usage:
//   node --import tsx --env-file=.env.local scripts/replay-neodove-unresolved.ts [--dry]

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { parseInboundEvent } from "@/lib/neodove/mapper";
import { handleNeodoveEvent } from "@/lib/neodove/inbound";

const DRY = process.argv.includes("--dry");

type Row = { id: string; request_payload: unknown; created_at: Date; error: string | null };

async function main(): Promise<void> {
    // Anything that recorded a failure reason and produced no touchpoint. Scoped
    // by the error text rather than "no touchpoint exists" so a genuinely
    // unprocessable event (no mobile at all) isn't retried forever.
    const rows = await db.execute<Row>(sql`
        SELECT id::text AS id, request_payload, created_at, error
          FROM neodove_sync_events
         WHERE direction = 'inbound'
           AND error IS NOT NULL
           AND error LIKE 'No dealer_lead matched%'
         ORDER BY created_at ASC
    `);

    console.log(`${rows.length} unresolved inbound event(s) to replay${DRY ? " (DRY RUN)" : ""}\n`);

    const tally: Record<string, number> = {};
    for (const row of rows) {
        const event = parseInboundEvent(row.request_payload);
        const label = `${event.occurredAt?.toISOString() ?? row.created_at.toISOString()} ${event.mobile ?? "(no mobile)"} ${event.name ?? ""}`.trim();

        if (DRY) {
            console.log(`  would replay  ${label}`);
            tally.dry = (tally.dry ?? 0) + 1;
            continue;
        }

        const outcome = await handleNeodoveEvent(event);
        tally[outcome.action] = (tally[outcome.action] ?? 0) + 1;
        console.log(`  ${outcome.action.padEnd(20)} ${label} -> ${outcome.dealerLeadId ?? "-"}`);

        // Clear the failure reason so a later run doesn't retry a row that has
        // now produced a touchpoint. Left in place when it failed again.
        if (outcome.handled) {
            await db.execute(sql`
                UPDATE neodove_sync_events SET error = NULL WHERE id = ${row.id}::uuid
            `);
        }
    }

    console.log("\nsummary:", JSON.stringify(tally));
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
