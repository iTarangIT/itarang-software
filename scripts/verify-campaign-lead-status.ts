// Proves the E-300 campaign-status rule against the REAL database.
//
//   node --import tsx --env-file=.env.local scripts/verify-campaign-lead-status.ts
//   … --expect-backfilled      also FAIL if any row / counter is not yet re-classified
//   … --phrases [N]            print the N most frequent dealer-turn texts on calls
//                              where the dealer barely spoke, to calibrate the
//                              carrier-announcement list. PRINTS TRANSCRIPT TEXT —
//                              off by default; run it only where that is allowed.
//
// What it checks:
//   1. The SQL twin (dealerSpokeSql) and the JS rule (dealerSpoke) agree on
//      every stored transcript. The hard block runs the SQL; the finalizers run
//      the JS; if they disagreed, a lead could be "completed" in the campaign
//      and still dialable, or the reverse.
//   2. The AI-connected predicate executes, and how many leads it unblocks
//      compared with the old "any transcript" definition.
//   3. How many finished rows still read the pre-E-300 vocabulary (the
//      backfill's to-do list), and whether each campaign's counters match its
//      rows.
//
// It IMPORTS the application rule and SQL instead of restating them — a
// restated copy would pass forever while the real one drifted.
//
// Entirely READ-ONLY: no DDL, no writes. Default output is counts and ids only.

import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import {
    ATTEMPTED_STATUSES,
    classifyCarrierAnnouncement,
    dealerSpoke,
    dealerSpokeSql,
    reclassifyStoredAttempt,
    sqlStatusList,
} from "../src/lib/ai-dialer/campaignLeadStatus";
import { AI_CONNECTED_PREDICATE } from "../src/lib/ai-dialer/exclusionFilter";
import { parseTranscriptTurns } from "../src/lib/ai-dialer/call-quality/transcript";

const args = process.argv.slice(2);
const EXPECT_BACKFILLED = args.includes("--expect-backfilled");
const PHRASES = args.includes("--phrases")
    ? Number(args[args.indexOf("--phrases") + 1]) || 40
    : 0;

let failed = 0;
const ok = (name: string) => console.log(`  PASS  ${name}`);
const bad = (name: string, detail: string) => {
    failed++;
    console.log(`  FAIL  ${name}\n        ${detail}`);
};
const info = (name: string, detail: string) => console.log(`  INFO  ${name}\n        ${detail}`);

function rowsOf<T>(result: unknown): T[] {
    return (result as { rows?: T[] }).rows ?? (result as T[]);
}

async function checkSqlTwin() {
    const rows = rowsOf<{ call_id: string | null; transcript: string; sql_spoke: boolean }>(
        await db.execute(sql`
            SELECT acl.call_id, acl.transcript, ${sql.raw(dealerSpokeSql("acl"))} AS sql_spoke
              FROM ai_call_logs acl
             WHERE acl.transcript IS NOT NULL
        `),
    );
    const mismatches = rows.filter((r) => dealerSpoke(r.transcript) !== Boolean(r.sql_spoke));
    const spoke = rows.filter((r) => dealerSpoke(r.transcript)).length;
    if (mismatches.length === 0) {
        ok(`SQL twin agrees with dealerSpoke() on all ${rows.length} transcripts (${spoke} with the dealer speaking)`);
    } else {
        bad(
            "SQL twin agrees with dealerSpoke()",
            `${mismatches.length} of ${rows.length} disagree, e.g. call_id ${mismatches
                .slice(0, 10)
                .map((m) => m.call_id)
                .join(", ")}`,
        );
    }
}

async function checkHardBlock() {
    const [r] = rowsOf<{ now_blocked: number; was_blocked: number }>(
        await db.execute(sql`
            SELECT
              count(*) FILTER (WHERE ${sql.raw(AI_CONNECTED_PREDICATE)})::int AS now_blocked,
              count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM ai_call_logs acl
                   WHERE acl.lead_id = dl.id AND acl.transcript IS NOT NULL))::int AS was_blocked
              FROM dealer_leads dl
        `),
    );
    ok(`AI-connected predicate executes`);
    info(
        "AI-connected hard block",
        `${r.now_blocked} lead(s) blocked now vs ${r.was_blocked} under "any transcript" — ` +
            `${r.was_blocked - r.now_blocked} become AI-redialable`,
    );
    if (r.now_blocked > r.was_blocked) {
        bad("the new block is a subset of the old", "it blocks MORE leads than before");
    }
}

async function checkBackfill() {
    const rows = rowsOf<{
        campaign_id: string;
        status: string;
        call_outcome: string | null;
        transcript: string | null;
        provider_status: string | null;
    }>(
        await db.execute(sql`
            SELECT dcl.campaign_id, dcl.status, dcl.call_outcome,
                   acl.transcript, acl.status AS provider_status
              FROM dialer_campaign_leads dcl
              LEFT JOIN LATERAL (
                    SELECT a.transcript, a.status FROM ai_call_logs a
                     WHERE dcl.bolna_call_id IS NOT NULL AND a.call_id = dcl.bolna_call_id
                     ORDER BY (a.transcript IS NOT NULL) DESC LIMIT 1
              ) acl ON true
             WHERE dcl.status NOT IN ('pending', 'calling')
        `),
    );
    const pending = new Map<string, number>();
    for (const r of rows) {
        const next = reclassifyStoredAttempt({
            status: r.status,
            callOutcome: r.call_outcome,
            transcript: r.transcript,
            providerStatus: r.provider_status,
        });
        if (next && next.status !== r.status) {
            const k = `${r.status} → ${next.status}`;
            pending.set(k, (pending.get(k) ?? 0) + 1);
        }
    }
    const total = [...pending.values()].reduce((a, b) => a + b, 0);
    if (total === 0) {
        ok(`every one of ${rows.length} finished rows already reads the E-300 vocabulary`);
    } else {
        const detail = [...pending.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([k, n]) => `${n} ${k}`)
            .join("; ");
        (EXPECT_BACKFILLED ? bad : info)(
            `${total} of ${rows.length} finished rows await the backfill`,
            detail,
        );
    }

    const attempted = sqlStatusList(ATTEMPTED_STATUSES);
    const [c] = rowsOf<{ stale: number; campaigns: number }>(
        await db.execute(sql`
            SELECT count(*) FILTER (WHERE c.completed_leads <> t.comp
                                       OR c.failed_leads <> t.fail
                                       OR c.calls_made <> t.attempted)::int AS stale,
                   count(*)::int AS campaigns
              FROM dialer_campaigns c
              JOIN (
                    SELECT campaign_id,
                           count(*) FILTER (WHERE status = 'completed')::int AS comp,
                           count(*) FILTER (WHERE status = 'failed')::int    AS fail,
                           count(*) FILTER (WHERE status IN (${sql.raw(attempted)}))::int AS attempted
                      FROM dialer_campaign_leads GROUP BY campaign_id
              ) t ON t.campaign_id = c.id
        `),
    );
    if (c.stale === 0) ok(`counters match the rows on all ${c.campaigns} campaigns`);
    else
        (EXPECT_BACKFILLED ? bad : info)(
            `counters differ from the rows on ${c.stale} of ${c.campaigns} campaigns`,
            "syncCampaignCounters (run by the backfill's --apply) re-derives them",
        );
}

async function printPhrases(n: number) {
    console.log(`\n  ── --phrases: top ${n} dealer-turn texts on calls with ≤ 2 dealer turns ──`);
    console.log("  (transcript text below — carrier announcements recur verbatim, real speech does not)\n");
    const rows = rowsOf<{ transcript: string }>(
        await db.execute(sql`SELECT transcript FROM ai_call_logs WHERE transcript IS NOT NULL`),
    );
    const freq = new Map<string, { n: number; spoke: boolean }>();
    for (const r of rows) {
        const user = parseTranscriptTurns(r.transcript).filter((t) => t.speaker === "user");
        if (user.length === 0 || user.length > 2) continue;
        for (const t of user) {
            const key = t.text.toLowerCase().replace(/\d/g, "#").replace(/\s+/g, " ").trim();
            if (!key) continue;
            const e = freq.get(key) ?? { n: 0, spoke: dealerSpoke(`user: ${t.text}`) };
            e.n++;
            freq.set(key, e);
        }
    }
    for (const [text, e] of [...freq.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, n)) {
        const kind = e.spoke ? "speech " : classifyCarrierAnnouncement(text) ? "ANNOUNC" : "silent ";
        console.log(`  ${String(e.n).padStart(5)}  ${kind}  ${text.slice(0, 140)}`);
    }
}

async function main() {
    console.log("verify-campaign-lead-status (read-only)\n");
    await checkSqlTwin();
    await checkHardBlock();
    await checkBackfill();
    if (PHRASES) await printPhrases(PHRASES);
    console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
}

main()
    .then(() => process.exit(failed === 0 ? 0 : 1))
    .catch((err) => {
        console.error("verify failed to run:", err);
        process.exit(1);
    });
