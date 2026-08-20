// Proves the campaign call-duration histogram SQL against the REAL database.
//
//   node --import tsx --env-file=.env.local scripts/verify-duration-histogram.ts
//
// Worth having because the behaviour that matters here lives in SQL, not in
// TypeScript. tsc cannot tell you that a half-open bucket join puts a
// 20-second call in the right bar, that a LEFT JOIN LATERAL reads ONE
// ai_call_logs row per lead rather than fanning out on the non-unique
// call_id index, or that every configured bucket still comes back when nothing
// landed in it. Those are the bugs this catches.
//
// Two properties make it trustworthy:
//
//   1. It IMPORTS buildDurationHistogramSql / bucketDefsJson /
//      BUCKET_MATCH_PREDICATE from the application modules instead of restating
//      them. A restated copy would pass forever while the real query drifted
//      underneath it. This is the verify-e254-campaign-window.ts rule.
//   2. The boundary section supplies its rows as an inline jsonb array, so the
//      arithmetic is asserted at exact synthetic durations rather than at
//      whatever happens to be in the database today.
//
// Entirely READ-ONLY: no DDL, no temp tables, no writes, nothing to roll back.

import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { dialerCampaignLeads } from "../src/lib/db/schema";
import { correlatedDurationSeconds } from "../src/lib/ai-dialer/call-duration/derive";
import { deriveBuckets, DEFAULT_DURATION_BUCKET_CONFIG } from "../src/lib/ai-dialer/call-duration/config";
import {
    BUCKET_MATCH_PREDICATE,
    bucketDefsJson,
    buildDurationHistogramSql,
    foldDurationHistogram,
    type DurationHistogramRow,
} from "../src/lib/ai-dialer/call-duration/histogram";

let failed = 0;
let skipped = 0;
const ok = (name: string) => console.log(`  PASS  ${name}`);
const bad = (name: string, detail: string) => {
    failed++;
    console.log(`  FAIL  ${name}\n        ${detail}`);
};
// A silent pass on absent data is the failure mode verification scripts exist to
// prevent, so a check that could not run says so out loud.
const skip = (name: string, why: string) => {
    skipped++;
    console.log(`  SKIP  ${name}\n        ${why}`);
};

const BUCKETS = deriveBuckets(DEFAULT_DURATION_BUCKET_CONFIG);
const DEFS = bucketDefsJson(BUCKETS);

/**
 * Bin a list of durations through the REAL bucket_defs CTE and the REAL join
 * predicate. Aliases `c` and `bd` are the ones BUCKET_MATCH_PREDICATE requires.
 */
async function binSynthetic(
    durations: Array<number | null>,
): Promise<Array<{ d: number | null; bucket_key: string | null }>> {
    const res = await db.execute(sql`
    WITH bucket_defs AS (
      SELECT (b.value->>'ord')::int  AS bucket_ord,
             (b.value->>'key')::text AS bucket_key,
             (b.value->>'lo')::int   AS lo,
             (b.value->>'hi')::int   AS hi
        FROM jsonb_array_elements(${DEFS}::jsonb) AS b(value)
    ),
    c AS (
      SELECT (v.value)::int AS duration_seconds
        FROM jsonb_array_elements_text(${JSON.stringify(durations)}::jsonb) AS v(value)
    )
    SELECT c.duration_seconds AS d, bd.bucket_key
      FROM c
      LEFT JOIN bucket_defs bd ON ${sql.raw(BUCKET_MATCH_PREDICATE)}
     ORDER BY c.duration_seconds NULLS LAST
  `);
    return Array.from(res) as Array<{ d: number | null; bucket_key: string | null }>;
}

async function boundarySection() {
    console.log("\nBucket boundaries (half-open, [lo, hi))");

    // The 20-second line is the whole point of the feature, so every edge gets
    // both sides asserted explicitly.
    const CASES: Array<[number, string]> = [
        [1, "lt20"],
        [19, "lt20"],
        [20, "s20_40"],
        [39, "s20_40"],
        [40, "s40_60"],
        [59, "s40_60"],
        [60, "s60_120"],
        [119, "s60_120"],
        [120, "s120_300"],
        [299, "s120_300"],
        [300, "gte300"],
        [99999, "gte300"],
    ];

    const rows = await binSynthetic(CASES.map(([d]) => d));
    const byDuration = new Map(rows.map((r) => [Number(r.d), r.bucket_key]));

    for (const [duration, expected] of CASES) {
        const actual = byDuration.get(duration);
        if (actual === expected) ok(`${duration}s lands in ${expected}`);
        else bad(`${duration}s lands in ${expected}`, `got ${actual ?? "no bucket"}`);
    }

    // The guard that matters most: an overlapping bucket set would double-count
    // a call and inflate the exact number this feature reports.
    const dupes = rows.filter(
        (r) => r.d != null && rows.filter((o) => Number(o.d) === Number(r.d)).length !== 1,
    );
    if (dupes.length === 0) ok("every duration matches exactly one bucket");
    else bad("every duration matches exactly one bucket", `${dupes.length} row(s) matched twice`);

    const nullRows = await binSynthetic([null]);
    if (nullRows.length === 1 && nullRows[0].bucket_key === null) {
        ok("a NULL duration is bucketed nowhere");
    } else {
        bad("a NULL duration is bucketed nowhere", JSON.stringify(nullRows));
    }
}

async function liveSection(): Promise<string | null> {
    console.log("\nLive campaign");

    // Chosen by completed_leads, not by lead count: the biggest campaign in the
    // table can be one that was queued and never dialled, and every invariant
    // below is trivially true on a campaign with no calls in it. The
    // denormalised counter makes this a cheap lookup rather than a full scan.
    const found = await db.execute(sql`
    SELECT id AS campaign_id, total_leads AS n, completed_leads
      FROM dialer_campaigns
     ORDER BY completed_leads DESC, total_leads DESC
     LIMIT 1
  `);
    const target = (
        Array.from(found) as Array<{ campaign_id: string; n: number; completed_leads: number }>
    )[0];

    if (!target) {
        skip("live campaign invariants", "no campaign has any leads in this database");
        return null;
    }

    console.log(`  (campaign ${target.campaign_id}, ${target.n} leads)`);

    const rows = Array.from(
        await db.execute(buildDurationHistogramSql(target.campaign_id, BUCKETS)),
    ) as unknown as DurationHistogramRow[];

    const out = foldDurationHistogram(
        rows,
        BUCKETS,
        { edgesSeconds: [...DEFAULT_DURATION_BUCKET_CONFIG.edgesSeconds], source: "default" },
        target.campaign_id,
    );
    const t = out.totals;

    console.log(
        `  (connected ${t.connectedLeads}, bucketed ${t.bucketedConnected}, ` +
            `median ${t.medianConnectedSeconds ?? "—"}s, completed ${t.completedLeads})`,
    );

    if (out.buckets.length === BUCKETS.length) ok("every configured bucket comes back");
    else bad("every configured bucket comes back", `got ${out.buckets.length} of ${BUCKETS.length}`);

    const keys = out.buckets.map((b) => b.key);
    if (new Set(keys).size === keys.length) ok("no bucket is returned twice");
    else bad("no bucket is returned twice", keys.join(", "));

    const summed = out.buckets.reduce((s, b) => s + b.count, 0);
    if (summed === t.bucketedConnected) ok("bucket counts sum to the bucketed total");
    else bad("bucket counts sum to the bucketed total", `${summed} != ${t.bucketedConnected}`);

    if (t.connectedLeads === t.bucketedConnected + t.connectedWithoutDuration) {
        ok("connected = bucketed + unbucketed");
    } else {
        bad(
            "connected = bucketed + unbucketed",
            `${t.connectedLeads} != ${t.bucketedConnected} + ${t.connectedWithoutDuration}`,
        );
    }

    // A connected row must have been dialled, so it cannot outnumber the attempts.
    if (t.connectedLeads <= t.attemptedLeads) ok("connected never exceeds attempted");
    else bad("connected never exceeds attempted", `${t.connectedLeads} > ${t.attemptedLeads}`);

    if (out.buckets.every((b) => b.count >= 0)) ok("no bucket count is negative");
    else bad("no bucket count is negative", JSON.stringify(out.buckets.map((b) => b.count)));

    for (const b of out.buckets) {
        const sliceTotal = b.outcomes.reduce((s, o) => s + o.count, 0);
        if (sliceTotal !== b.count) {
            bad(
                `outcome slices account for every call in ${b.label}`,
                `slices ${sliceTotal} != bucket ${b.count}`,
            );
            break;
        }
    }
    ok("outcome slices account for every call in every bucket");

    // The fanout guard. ai_call_logs.call_id is NOT unique, so a plain LEFT JOIN
    // here would multiply rows and silently inflate every count above.
    const dupProbe = await db.execute(sql`
    SELECT dcl.bolna_call_id, count(*)::int AS n
      FROM dialer_campaign_leads dcl
      JOIN ai_call_logs a ON a.call_id = dcl.bolna_call_id
     WHERE dcl.campaign_id = ${target.campaign_id}
       AND dcl.bolna_call_id IS NOT NULL
     GROUP BY dcl.bolna_call_id
    HAVING count(*) > 1
     LIMIT 1
  `);

    if (Array.from(dupProbe).length === 0) {
        skip(
            "LATERAL does not inflate counts on a duplicated call_id",
            "no bolna_call_id in this campaign has more than one ai_call_logs row",
        );
    } else {
        const plain = await db.execute(sql`
      SELECT count(*)::int AS n
        FROM dialer_campaign_leads dcl
       WHERE dcl.campaign_id = ${target.campaign_id}
    `);
        const leadCount = (Array.from(plain) as Array<{ n: number }>)[0]?.n ?? 0;
        if (t.campaignLeads === leadCount) {
            ok("LATERAL does not inflate counts on a duplicated call_id");
        } else {
            bad(
                "LATERAL does not inflate counts on a duplicated call_id",
                `histogram saw ${t.campaignLeads} leads, table has ${leadCount}`,
            );
        }
    }

    return target.campaign_id;
}

/**
 * The cross-check that matters most.
 *
 * Clicking a bar filters the lead table through a DIFFERENT query — the leads
 * route's correlated duration expression rather than the histogram's LATERAL
 * one. If those two ever disagree, a bar reads 47 and the table it opens shows
 * 44, and nobody finds out why. This asserts they agree, bucket by bucket, on
 * real data.
 */
async function filterAgreementSection(campaignId: string) {
    console.log("\nBar count vs. the filtered lead table");

    const rows = Array.from(
        await db.execute(buildDurationHistogramSql(campaignId, BUCKETS)),
    ) as unknown as DurationHistogramRow[];
    const out = foldDurationHistogram(
        rows,
        BUCKETS,
        { edgesSeconds: [...DEFAULT_DURATION_BUCKET_CONFIG.edgesSeconds], source: "default" },
        campaignId,
    );

    for (const bucket of out.buckets) {
        // Exactly the predicate the leads route builds for ?durationBucket=…
        const duration = correlatedDurationSeconds(
            dialerCampaignLeads.started_at,
            dialerCampaignLeads.completed_at,
            dialerCampaignLeads.bolna_call_id,
        );
        const conditions = [
            eq(dialerCampaignLeads.campaign_id, campaignId),
            sql`${duration} >= ${bucket.loSeconds}`,
        ];
        if (bucket.hiSeconds !== null) {
            conditions.push(sql`${duration} < ${bucket.hiSeconds}`);
        }

        const [{ n }] = (await db
            .select({ n: sql<number>`count(*)::int` })
            .from(dialerCampaignLeads)
            .where(and(...conditions))) as Array<{ n: number }>;

        if (Number(n) === bucket.count) {
            ok(`${bucket.label}: bar ${bucket.count} = table ${n}`);
        } else {
            bad(`${bucket.label}: bar and table agree`, `bar ${bucket.count}, table ${n}`);
        }
    }
}


async function main() {
    console.log("Verifying campaign call-duration histogram (read-only)");
    await boundarySection();
    const campaignId = await liveSection();
    if (campaignId) await filterAgreementSection(campaignId);

    console.log(
        `\n${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`}` +
            (skipped > 0 ? ` — ${skipped} skipped` : ""),
    );
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
