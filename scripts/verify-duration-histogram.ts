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
import {
    correlatedDurationSeconds,
    DURATION_SECONDS_SQL,
} from "../src/lib/ai-dialer/call-duration/derive";
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


/**
 * The regression this whole rule exists to prevent, asserted against live rows.
 *
 * `dialer_campaign_leads.started_at` / `completed_at` bracket the DIALER'S
 * ATTEMPT, not a conversation. A `trigger_failed` lead — the provider rejected
 * the trigger outright and no phone ever rang — still carries both timestamps,
 * five to sixty seconds apart. While the duration rule accepted that wall clock
 * on its own, every one of those leads was bucketed by how long the dialer took
 * to fail: one production campaign of 146 leads (71 completed, 75 failed)
 * reported all 146 as "measured calls".
 *
 * Two scans, both database-wide rather than one-campaign, because the defect
 * was a property of the RULE and could reappear on any campaign:
 *
 *   1. no lead lacking both forms of connection evidence has a duration;
 *   2. no `trigger_failed` lead has a duration at all.
 *
 * Cheap: a count over dialer_campaign_leads with one correlated subquery each,
 * the same shape the leads route already pays per row.
 */
/**
 * Total talk time on the campaigns LIST vs. the campaign DETAIL panel.
 *
 * Two screens, two different queries, one number. api/ai-dialer/campaigns and
 * api/campaigns/unified each compute `totalTalkTimeSeconds` with a correlated
 * SUM; the panel gets its `totalTalkSeconds` out of the histogram CTE. All
 * three now bind DURATION_SECONDS_SQL, and the list route's comment claims in
 * so many words that its total IS the sum of the detail table's Duration cells.
 * This is that claim, executed.
 *
 * It also serves as the only place either list query's SQL is run at all — a
 * type-check cannot tell you that a hand-written correlated subquery parses,
 * and neither can vitest.
 */
async function listAgreementSection(campaignId: string) {
    console.log("\nCampaigns-list talk time vs. the detail panel");

    // The same shape both list routes build: one LATERAL per lead, the shared
    // predicate, coalesced to 0 so a SUM behaves.
    const [{ total }] = (await db.execute(sql`
        SELECT COALESCE(SUM(COALESCE(${DURATION_SECONDS_SQL}, 0)), 0)::int AS total
          FROM dialer_campaign_leads dcl
          LEFT JOIN LATERAL (
            SELECT a.call_duration, a.transcript
              FROM ai_call_logs a
             WHERE a.call_id = dcl.bolna_call_id
             ORDER BY a.updated_at DESC NULLS LAST
             LIMIT 1
          ) acl ON TRUE
         WHERE dcl.campaign_id = ${campaignId}
    `)) as unknown as Array<{ total: number }>;

    const rows = Array.from(
        await db.execute(buildDurationHistogramSql(campaignId, BUCKETS)),
    ) as unknown as DurationHistogramRow[];
    const panel = foldDurationHistogram(
        rows,
        BUCKETS,
        { edgesSeconds: [...DEFAULT_DURATION_BUCKET_CONFIG.edgesSeconds], source: "default" },
        campaignId,
    ).totals.totalTalkSeconds;

    if (Number(total) === panel) {
        ok(`list total ${total}s = panel total ${panel}s`);
    } else {
        bad("list and panel agree on total talk time", `list ${total}s, panel ${panel}s`);
    }
}

async function neverConnectedSection() {
    console.log("\nCalls that never connected have no duration");

    const duration = correlatedDurationSeconds(
        dialerCampaignLeads.started_at,
        dialerCampaignLeads.completed_at,
        dialerCampaignLeads.bolna_call_id,
    );

    // The evidence the rule accepts: a transcript, or provider-reported talk
    // time. Restated here as a subquery rather than imported, because this is
    // the INDEPENDENT check — importing CONNECTED_PREDICATE would make the
    // assertion true by construction and prove nothing.
    const evidence = sql`EXISTS (
        SELECT 1 FROM ai_call_logs a
         WHERE a.call_id = ${dialerCampaignLeads.bolna_call_id}
           AND (a.transcript IS NOT NULL OR (a.call_duration IS NOT NULL AND a.call_duration > 0))
    )`;

    const [{ n: ghosts }] = (await db
        .select({ n: sql<number>`count(*)::int` })
        .from(dialerCampaignLeads)
        .where(and(sql`NOT ${evidence}`, sql`${duration} IS NOT NULL`))) as Array<{ n: number }>;

    if (Number(ghosts) === 0) {
        ok("no lead without a transcript or provider talk time carries a duration");
    } else {
        bad(
            "no lead without a transcript or provider talk time carries a duration",
            `${ghosts} lead(s) would be bucketed on dialer latency alone`,
        );
    }

    const [{ n: triggerFailed }] = (await db
        .select({ n: sql<number>`count(*)::int` })
        .from(dialerCampaignLeads)
        .where(
            and(
                sql`${dialerCampaignLeads.call_outcome} LIKE 'trigger_failed%'`,
                sql`${duration} IS NOT NULL`,
            ),
        )) as Array<{ n: number }>;

    if (Number(triggerFailed) === 0) {
        ok("no trigger_failed lead is bucketed");
    } else {
        bad("no trigger_failed lead is bucketed", `${triggerFailed} lead(s) still bucketed`);
    }

    // Scale of what the rule is holding back, for the log. Not an assertion:
    // this number is expected to be LARGE and is the reason the rule exists.
    const [{ n: wallOnly }] = (await db
        .select({ n: sql<number>`count(*)::int` })
        .from(dialerCampaignLeads)
        .where(
            and(
                sql`NOT ${evidence}`,
                sql`${dialerCampaignLeads.started_at} IS NOT NULL`,
                sql`${dialerCampaignLeads.completed_at} IS NOT NULL`,
                sql`extract(epoch FROM (${dialerCampaignLeads.completed_at} - ${dialerCampaignLeads.started_at})) > 0`,
            ),
        )) as Array<{ n: number }>;
    console.log(
        `  (${wallOnly} lead(s) carry positive wall-clock time with no connection evidence — ` +
            "each one a bar this rule keeps out of the chart)",
    );
}

/**
 * The counter the campaign header reads, checked against the rows it summarises.
 *
 * calls_made was an alias of completed_leads until E-266, which is why the
 * header printed "Calls made 71" beside "Completed 71" on a campaign with 75
 * further failed attempts, and why the progress bar sat at 0% on a campaign
 * whose leads had all failed.
 */
async function counterSection() {
    console.log("\ndialer_campaigns counters vs. their rows");

    const drift = Array.from(
        await db.execute(sql`
        SELECT c.id, c.calls_made, c.completed_leads, c.failed_leads,
               t.comp, t.fail
          FROM dialer_campaigns c
          JOIN (
            SELECT campaign_id,
                   count(*) FILTER (WHERE status = 'completed')::int AS comp,
                   count(*) FILTER (WHERE status = 'failed')::int    AS fail
              FROM dialer_campaign_leads
             GROUP BY campaign_id
          ) t ON t.campaign_id = c.id
         WHERE c.calls_made      IS DISTINCT FROM t.comp + t.fail
            OR c.completed_leads IS DISTINCT FROM t.comp
            OR c.failed_leads    IS DISTINCT FROM t.fail
         LIMIT 5
    `),
    ) as Array<Record<string, unknown>>;

    if (drift.length === 0) {
        ok("calls_made = completed + failed on every campaign");
    } else {
        // Not a code failure if E-266 has not been applied to this database —
        // say which, so the reader does not go hunting in campaignTracker.ts.
        bad(
            "calls_made = completed + failed on every campaign",
            `${drift.length}+ campaign(s) drift, e.g. ${JSON.stringify(drift[0])}` +
                " — apply drizzle/E-266_recompute_campaign_calls_made.sql to this database",
        );
    }
}

async function main() {
    console.log("Verifying campaign call-duration histogram (read-only)");
    await boundarySection();
    const campaignId = await liveSection();
    if (campaignId) await filterAgreementSection(campaignId);
    if (campaignId) await listAgreementSection(campaignId);
    await neverConnectedSection();
    await counterSection();

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
