// ID 224 item 1 — one-time re-run of the NeoDove recordings that arrived
// before their format was understood. NeoDove's workflow sends
//   "recording_url": [{ "recording_url": "https://…", "call_duration_in_sec": 90 }]
// (a list, not a link), so every CALL_RECORDING event was stored on the
// ledger (neodove_sync_events) but never attached to its call (21 on live,
// 10 Nov). The live webhook reads the list now (src/lib/neodove/mapper.ts,
// unwrapRecordingList); this attaches the ones already received.
//
// For each unattached recording: the lead's NeoDove call without a recording
// whose arrival is nearest to the recording's arrival, within 3 hours either
// side (the same pairing window the webhook uses). It stores the link (our own
// copy when the download works) and the duration, and marks the ledger row
// used, so re-running is a no-op.
//
// Dry run by default: prints what it would attach. --apply writes. On the live
// database --apply also needs --confirm-live.
//
//   node --import tsx --env-file=.env.local scripts/fix-id224-neodove-recordings.ts
//   node --import tsx --env-file=.env.production scripts/fix-id224-neodove-recordings.ts --apply --confirm-live

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { parseInboundEvent } from "@/lib/neodove/mapper";

const args = process.argv.slice(2);
const apply = args.includes("--apply");

type Ev = { external_event_id: string; dealer_lead_id: string; created_at: string; request_payload: unknown };

async function main() {
    const host = new URL(process.env.DATABASE_URL ?? "postgres://unset").host;
    const live = /database-2/.test(host);
    console.log(`Database: ${live ? "database-2 (LIVE)" : host.split(".")[0]}  ·  ${apply ? "APPLY" : "dry run"}`);
    if (apply && live && !args.includes("--confirm-live")) {
        console.error("Refusing to write to the live database without --confirm-live.");
        process.exit(1);
    }

    const events = (await db.execute(sql`
        SELECT external_event_id, dealer_lead_id, created_at::text AS created_at, request_payload
          FROM neodove_sync_events
         WHERE direction = 'inbound'
           AND event_type = 'call_recording'
           AND dealer_lead_id IS NOT NULL
           AND (response_payload ->> 'recording_attached_to') IS NULL
         ORDER BY created_at
    `)) as unknown as Ev[];
    console.log(`Unattached recordings on the ledger: ${events.length}`);

    let attached = 0;
    let noLink = 0;
    let noCall = 0;
    const used = new Set<string>();
    for (const ev of events) {
        const parsed = parseInboundEvent(ev.request_payload);
        // NeoDove's "Call Connected" list often has an empty link but the
        // duration; attach whichever is there.
        if (!parsed.recordingUrl && parsed.callDurationSec == null) {
            noLink += 1;
            continue;
        }
        const calls = (await db.execute(sql`
            SELECT touchpoint_id::text AS touchpoint_id,
                   round(abs(extract(epoch FROM (created_at - ${ev.created_at}::timestamptz))) / 60)::int AS gap_min
              FROM lead_touchpoints
             WHERE dealer_lead_id = ${ev.dealer_lead_id}
               AND external_system = 'neodove'
               AND touchpoint_type = 'inside_sales_call'
               AND recording_url IS NULL
               AND created_at BETWEEN ${ev.created_at}::timestamptz - interval '3 hours'
                                  AND ${ev.created_at}::timestamptz + interval '3 hours'
             ORDER BY abs(extract(epoch FROM (created_at - ${ev.created_at}::timestamptz)))
             LIMIT 5
        `)) as unknown as Array<{ touchpoint_id: string; gap_min: number }>;
        const call = calls.find((c) => !used.has(c.touchpoint_id));
        if (!call) {
            noCall += 1;
            console.log(`  no call within 3 h  lead ${ev.dealer_lead_id}  recording received ${ev.created_at}`);
            continue;
        }
        used.add(call.touchpoint_id);
        attached += 1;
        console.log(
            `  ${apply ? "attach" : "would attach"}  lead ${ev.dealer_lead_id} → call ${call.touchpoint_id} ` +
                `(${call.gap_min} min apart, link ${parsed.recordingUrl ? "yes" : "empty"}, duration ${parsed.callDurationSec ?? "—"} s)`,
        );
        if (apply) {
            // Loaded only to write: inbound.ts needs the full app env (Supabase,
            // storage); a dry run needs just DATABASE_URL.
            const { markRecordingUsed, storeRecordingOnly } = await import("@/lib/neodove/inbound");
            await storeRecordingOnly(call.touchpoint_id, parsed.recordingUrl, parsed.callDurationSec);
            await markRecordingUsed(ev.external_event_id, call.touchpoint_id);
        }
    }
    console.log(
        `\n${apply ? "Attached" : "Would attach"}: ${attached}  ·  neither link nor duration: ${noLink}  ·  no matching call: ${noCall}`,
    );
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e instanceof Error ? e.stack : e);
        process.exit(1);
    });
