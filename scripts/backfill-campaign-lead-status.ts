// Re-classify historical dialer_campaign_leads rows with the E-300 rule —
// "completed" means the dealer actually spoke.
//
//   node --import tsx --env-file=.env.local scripts/backfill-campaign-lead-status.ts
//       dry run: prints the before → after transition matrix, writes nothing
//   node --import tsx --env-file=.env.local scripts/backfill-campaign-lead-status.ts --apply
//       writes the changes, then re-derives every scanned campaign's counters
//   … --campaign <id>
//       limit to one campaign
//
// WHY A SCRIPT AND NOT SQL IN E-300. The rule parses transcripts and carrier
// announcements. It lives in src/lib/ai-dialer/campaignLeadStatus.ts, which the
// finalizers call on every live call; this script IMPORTS it
// (reclassifyStoredAttempt) instead of restating it, so history and new calls
// are classified by the same code.
//
// SAFE TO RE-RUN. The classifier is idempotent, so a second --apply changes 0
// rows. Only finished rows are touched — pending / calling are never read for
// writing — and every UPDATE is guarded on the status it read, so a row the
// live dialer moved in the meantime is left alone. The counter re-derive is
// syncCampaignCounters, the same function every campaign event runs.
//
// Prints counts and ids only — never transcript text.

import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import {
    reclassifyStoredAttempt,
    type StoredClassification,
} from "../src/lib/ai-dialer/campaignLeadStatus";
import { syncCampaignCounters } from "../src/lib/queue/campaignTracker";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const campaignArg = args.includes("--campaign") ? args[args.indexOf("--campaign") + 1] : null;

type Row = {
    id: string;
    campaign_id: string;
    status: string;
    call_outcome: string | null;
    transcript: string | null;
    provider_status: string | null;
};

type Change = {
    id: string;
    from_status: string;
    to_status: StoredClassification["status"];
    outcome: string | null;
};

function rowsOf<T>(result: unknown): T[] {
    return (result as { rows?: T[] }).rows ?? (result as T[]);
}

async function main() {
    const host = (() => {
        try {
            return new URL(process.env.DATABASE_URL ?? "").hostname;
        } catch {
            return "(unparseable DATABASE_URL)";
        }
    })();
    console.log(`backfill-campaign-lead-status — ${APPLY ? "APPLY" : "dry run"} against ${host}`);
    if (campaignArg) console.log(`  scope: campaign ${campaignArg}`);

    // One ai_call_logs row per attempt: call_id is not unique, so prefer the
    // row that carries the transcript. Same evidence the campaign table reads.
    const rows = rowsOf<Row>(
        await db.execute(sql`
            SELECT dcl.id, dcl.campaign_id, dcl.status, dcl.call_outcome,
                   acl.transcript, acl.status AS provider_status
              FROM dialer_campaign_leads dcl
              LEFT JOIN LATERAL (
                    SELECT a.transcript, a.status
                      FROM ai_call_logs a
                     WHERE dcl.bolna_call_id IS NOT NULL
                       AND a.call_id = dcl.bolna_call_id
                     ORDER BY (a.transcript IS NOT NULL) DESC
                     LIMIT 1
              ) acl ON true
             WHERE dcl.status NOT IN ('pending', 'calling')
               ${campaignArg ? sql`AND dcl.campaign_id = ${campaignArg}` : sql``}
        `),
    );

    const matrix = new Map<string, number>();
    const changesByCampaign = new Map<string, Change[]>();
    const campaigns = new Set<string>();

    for (const r of rows) {
        campaigns.add(r.campaign_id);
        const next = reclassifyStoredAttempt({
            status: r.status,
            callOutcome: r.call_outcome,
            transcript: r.transcript,
            providerStatus: r.provider_status,
        });
        if (!next) continue;

        const key = `${r.status} → ${next.status}`;
        matrix.set(key, (matrix.get(key) ?? 0) + 1);

        const outcomeChanges = next.outcome != null && next.outcome !== r.call_outcome;
        if (next.status === r.status && !outcomeChanges) continue;

        const list = changesByCampaign.get(r.campaign_id) ?? [];
        list.push({
            id: r.id,
            from_status: r.status,
            to_status: next.status,
            outcome: next.outcome,
        });
        changesByCampaign.set(r.campaign_id, list);
    }

    const totalChanges = [...changesByCampaign.values()].reduce((n, l) => n + l.length, 0);

    console.log(`\n  scanned ${rows.length} finished rows across ${campaigns.size} campaign(s)`);
    console.log(`  transition matrix (stored → re-classified):`);
    for (const [k, n] of [...matrix.entries()].sort((a, b) => b[1] - a[1])) {
        const same = k.split(" → ")[0] === k.split(" → ")[1];
        console.log(`    ${String(n).padStart(6)}  ${k}${same ? "  (unchanged)" : ""}`);
    }
    console.log(`  rows to change: ${totalChanges} in ${changesByCampaign.size} campaign(s)`);

    if (!APPLY) {
        console.log("\n  dry run — nothing written. Re-run with --apply to write.");
        return;
    }

    let written = 0;
    for (const [campaignId, changes] of changesByCampaign) {
        // One statement per campaign. `d.status = v.from_status` is the guard:
        // a row the live dialer changed since the read is skipped, not clobbered.
        const result = await db.execute(sql`
            UPDATE dialer_campaign_leads d
               SET status = v.to_status,
                   call_outcome = COALESCE(v.outcome, d.call_outcome)
              FROM jsonb_to_recordset(${JSON.stringify(changes)}::jsonb)
                   AS v(id text, from_status text, to_status text, outcome text)
             WHERE d.id = v.id
               AND d.status = v.from_status
            RETURNING d.id
        `);
        const n = rowsOf<{ id: string }>(result).length;
        written += n;
        if (n !== changes.length) {
            console.log(
                `  ${campaignId}: wrote ${n} of ${changes.length} (the rest changed since the read)`,
            );
        }
    }

    // Every scanned campaign, not only the touched ones: calls_made now
    // excludes skipped rows and failed_leads excludes the new statuses, so a
    // campaign whose rows did not change can still have stale counters.
    for (const campaignId of campaigns) {
        await syncCampaignCounters(campaignId);
    }

    console.log(`\n  wrote ${written} row(s); re-derived counters for ${campaigns.size} campaign(s).`);
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error("backfill failed:", err);
        process.exit(1);
    });
