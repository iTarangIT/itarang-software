// One-off: bring AI-call history in line with D2 / B5 (Step 3, 28 Oct).
//
//   node --import tsx --env-file=.env.local scripts/_backfill-d2-history.ts [--apply]
//
// Run AFTER scripts/backfill-campaign-lead-status.ts --apply, which re-classifies
// the campaign rows themselves (voicemail → switchboard for IVR transcripts).
// This script does the two things that one does not:
//
//   1. Number marks (E-361). Replays every lead's finished campaign attempts in
//      order through phoneTypeStore.noteCallResultForNumber — the function live
//      calls use — so a switchboard / dead number is marked and a later call
//      that reached a person clears it.
//   2. CEO "connected" (B5). AI-call touchpoints written as connected because
//      the call had a transcript are re-mapped with mapAiCallToDisposition and
//      the call's campaign status (or dealerSpoke when there is none). Only
//      connected → not connected is written; connected calls keep their label.
//      dealer_leads.last_* is moved too, but only where that touchpoint is the
//      one the rollup came from (same source, same time).
//
// Dry run by default: prints counts, writes nothing. Idempotent.
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { noteCallResultForNumber, hasPhoneTypeTable } from "../src/lib/ai-dialer/phoneTypeStore";
import { mapAiCallToDisposition } from "../src/lib/leads/aiDisposition";

const APPLY = process.argv.includes("--apply");

function rowsOf<T>(r: unknown): T[] {
    return (Array.isArray(r) ? r : (r as { rows?: T[] }).rows) ?? [];
}

async function numberMarks() {
    if (!(await hasPhoneTypeTable())) {
        console.log("  E-361 not applied here — number marks skipped");
        return;
    }
    const rows = rowsOf<{ lead_id: string; status: string; call_outcome: string | null }>(
        await db.execute(sql`
            SELECT lead_id, status, call_outcome
              FROM dialer_campaign_leads
             WHERE status IN ('switchboard', 'failed', 'completed')
             ORDER BY lead_id, completed_at NULLS FIRST
        `),
    );
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
    console.log(`  finished attempts to replay: ${rows.length}`, counts);
    if (!APPLY) return;
    for (const r of rows) await noteCallResultForNumber(r.lead_id, r.status, r.call_outcome);
    const marked = rowsOf<{ phone_type: string; n: number }>(
        await db.execute(sql`
            SELECT phone_type, count(*)::int AS n FROM dealer_lead_phone_type
             WHERE phone_type IN ('switchboard', 'dead_number') GROUP BY 1`),
    );
    console.log("  numbers now marked:", Object.fromEntries(marked.map((m) => [m.phone_type, m.n])));
}

async function ceoConnected() {
    // Every AI touchpoint still marked connected, with its call's evidence and
    // the campaign row that call produced (if any).
    const rows = rowsOf<{
        touchpoint_id: string;
        dealer_lead_id: string;
        performed_at: string;
        transcript: string | null;
        provider_status: string | null;
        campaign_status: string | null;
    }>(
        await db.execute(sql`
            SELECT tp.touchpoint_id, tp.dealer_lead_id, tp.performed_at,
                   acl.transcript, acl.status AS provider_status,
                   (SELECT dcl.status FROM dialer_campaign_leads dcl
                     WHERE dcl.bolna_call_id = tp.external_event_id
                     ORDER BY dcl.completed_at DESC NULLS LAST LIMIT 1) AS campaign_status
              FROM lead_touchpoints tp
              JOIN ai_call_logs acl ON acl.call_id = tp.external_event_id
             WHERE tp.touchpoint_type = 'ai_call'
               AND tp.connect_status = 'connected'
        `),
    );
    const flips = rows
        .map((r) => ({
            r,
            d: mapAiCallToDisposition({
                transcript: r.transcript,
                providerStatus: r.provider_status,
                callEndStatus: r.campaign_status,
            }),
        }))
        .filter(({ d }) => d.connectStatus === "not_connected");
    console.log(`  AI touchpoints marked connected: ${rows.length}; a person did not speak on ${flips.length}`);
    if (!APPLY || flips.length === 0) return;

    let leads = 0;
    for (const { r, d } of flips) {
        await db.execute(sql`
            UPDATE lead_touchpoints
               SET connect_status = ${d.connectStatus},
                   disposition = ${d.disposition},
                   disposition_bucket = NULL,
                   call_status = ${d.callStatus}
             WHERE touchpoint_id = ${r.touchpoint_id}::uuid
        `);
        const res = rowsOf<{ id: string }>(
            await db.execute(sql`
                UPDATE dealer_leads
                   SET last_connect_status = ${d.connectStatus},
                       last_disposition = ${d.disposition},
                       last_disposition_bucket = NULL
                 WHERE id = ${r.dealer_lead_id}
                   AND last_disposition_source = 'ai_dialer'
                   AND last_disposition_at = ${new Date(r.performed_at).toISOString()}::timestamptz
                RETURNING id
            `),
        );
        leads += res.length;
    }
    console.log(`  re-mapped ${flips.length} touchpoints; moved ${leads} lead rollups`);
}

async function main() {
    console.log(`D2 history — ${APPLY ? "APPLY" : "dry run"} against ${new URL(process.env.DATABASE_URL!).host.split(".")[0]}`);
    console.log("1. number marks");
    await numberMarks();
    console.log("2. CEO connected");
    await ceoConnected();
    if (!APPLY) console.log("\ndry run — nothing written. Re-run with --apply.");
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
