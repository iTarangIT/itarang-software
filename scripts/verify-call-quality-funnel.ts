// Proves the campaign call-quality funnel against the REAL database.
//
//   node --import tsx --env-file=.env.local scripts/verify-call-quality-funnel.ts
//
// Worth having because the behaviour that matters lives in the interaction
// between stored text and the parser, and neither tsc nor vitest can tell you
// that the transcripts actually in the database still match the format the
// parser inverts. Those are the bugs this catches:
//
//   · a provider changing its stringify shape, so every transcript silently
//     parses to zero turns and the whole funnel reads 0%;
//   · the opening fingerprint fragmenting one script into many because a new
//     script is longer than FINGERPRINT_CHARS at its point of divergence;
//   · a stage exceeding the stage above it, which means a denominator is wrong.
//
// It IMPORTS parseTranscriptTurns / buildCallQualityFunnel from the application
// modules rather than restating them — a restated copy passes forever while the
// real thing drifts underneath it. Same rule as verify-duration-histogram.ts.
//
// Entirely READ-ONLY: every statement is a SELECT.
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import {
    FINGERPRINT_CHARS,
    greetingState,
    openingFingerprint,
    parseTranscriptTurns,
} from "../src/lib/ai-dialer/call-quality/transcript";
import {
    buildCallQualityFunnel,
    type CallQualityRow,
} from "../src/lib/ai-dialer/call-quality/funnel";
import {
    asCallQualityRows,
    buildCallQualitySql,
    hasTranscriptTurnsColumn,
} from "../src/lib/ai-dialer/call-quality/query";
import { deriveBuckets, DEFAULT_DURATION_BUCKET_CONFIG } from "../src/lib/ai-dialer/call-duration/config";
import {
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
const skip = (name: string, why: string) => {
    skipped++;
    console.log(`  SKIP  ${name}\n        ${why}`);
};

/**
 * Campaign-scoped rows, through the ENDPOINT'S OWN query builder.
 *
 * Imported rather than restated — a restated copy passes forever while the real
 * query drifts underneath it, which is the whole reason this file exists.
 */
async function loadCampaignRows(campaignId: string): Promise<CallQualityRow[]> {
    const withTurns = await hasTranscriptTurnsColumn();
    return asCallQualityRows(
        await db.execute(buildCallQualitySql(campaignId, { withTurns })),
    );
}

/**
 * The same shape unscoped, for the database-wide sweep.
 *
 * This one IS hand-written, because buildCallQualitySql is campaign-scoped by
 * design and widening it for a verification script would be the tail wagging
 * the dog. The per-campaign section below runs the real builder, so a drift
 * between the two is still caught there.
 */
async function loadAllRows(): Promise<CallQualityRow[]> {
    return asCallQualityRows(
        await db.execute(sql`
        SELECT dcl.status,
               dcl.call_outcome            AS "callOutcome",
               acl.call_duration           AS "providerDurationSeconds",
               acl.transcript,
               acl.info_signals_count      AS "infoSignalsCount"
          FROM dialer_campaign_leads dcl
          LEFT JOIN LATERAL (
            SELECT a.call_duration, a.transcript, a.info_signals_count
              FROM ai_call_logs a
             WHERE a.call_id = dcl.bolna_call_id
             ORDER BY a.updated_at DESC NULLS LAST
             LIMIT 1
          ) acl ON TRUE
    `),
    );
}

async function parserSection() {
    console.log("\nParser vs. the transcripts actually stored");

    const rows = Array.from(
        await db.execute(sql`
        SELECT call_id, transcript
          FROM ai_call_logs
         WHERE transcript IS NOT NULL AND length(trim(transcript)) > 0
    `),
    ) as Array<{ call_id: string; transcript: string }>;

    if (rows.length === 0) {
        skip("parser round-trips every stored transcript", "no transcripts in this database");
        return;
    }
    console.log(`  (${rows.length} transcripts)`);

    // A transcript that parses to zero turns means the stored format no longer
    // matches what the parser inverts — the single failure that would zero the
    // whole funnel while every unit test still passed.
    const empty = rows.filter((r) => parseTranscriptTurns(r.transcript).length === 0);
    if (empty.length === 0) ok("every stored transcript parses to at least one turn");
    else bad("every stored transcript parses to at least one turn", `${empty.length} parsed to zero, e.g. ${empty[0].call_id}`);

    // Continuation lines and exotic speakers were both zero when the parser was
    // written. They are ALLOWED — the parser handles them — so this reports
    // rather than fails. A jump means the provider changed something.
    let continuations = 0;
    const speakers = new Set<string>();
    for (const r of rows) {
        for (const line of r.transcript.split("\n")) {
            if (line.trim() !== "" && !/^[a-z0-9_-]{1,20}:/i.test(line)) continuations++;
        }
        for (const t of parseTranscriptTurns(r.transcript)) speakers.add(t.speaker);
    }
    console.log(`  (continuation lines: ${continuations}; speakers seen: ${[...speakers].join(", ")})`);

    const unexpected = [...speakers].filter((s) => s !== "agent" && s !== "user");
    if (unexpected.length === 0) ok("only agent/user speakers appear");
    else skip("only agent/user speakers appear", `also saw: ${unexpected.join(", ")} — parser handles it, but check the funnel still means what it says`);

    // The fingerprint must not fragment one script by where its audio stopped.
    // If shortening the key collapses variants sharply, FINGERPRINT_CHARS is
    // too long for the scripts now in use.
    const atConfigured = new Set(
        rows.map((r) => openingFingerprint(parseTranscriptTurns(r.transcript))).filter(Boolean),
    );
    const atHalf = new Set(
        rows
            .map((r) => openingFingerprint(parseTranscriptTurns(r.transcript)))
            .filter(Boolean)
            .map((k) => k!.slice(0, Math.floor(FINGERPRINT_CHARS / 2))),
    );
    console.log(
        `  (distinct openers at ${FINGERPRINT_CHARS} chars: ${atConfigured.size}; at ${Math.floor(FINGERPRINT_CHARS / 2)}: ${atHalf.size})`,
    );
    if (atConfigured.size <= atHalf.size * 2) {
        ok("opening fingerprint is not fragmenting one script into many");
    } else {
        bad(
            "opening fingerprint is not fragmenting one script into many",
            `${atConfigured.size} openers at ${FINGERPRINT_CHARS} chars collapses to ${atHalf.size} at half that — FINGERPRINT_CHARS is too long for the current scripts`,
        );
    }

    const states = { complete: 0, cut_off: 0, absent: 0 };
    for (const r of rows) states[greetingState(parseTranscriptTurns(r.transcript))]++;
    console.log(
        `  (greeting complete ${states.complete}, cut off ${states.cut_off}, absent ${states.absent})`,
    );
}

async function funnelSection() {
    console.log("\nFunnel invariants, database-wide");

    const rows = await loadAllRows();
    if (rows.length === 0) {
        skip("funnel invariants", "no campaign leads in this database");
        return;
    }
    const f = buildCallQualityFunnel(rows);
    console.log(
        `  (attempted ${f.attempted} -> dialled ${f.dialled} -> answered ${f.answered} ` +
            `-> transcript ${f.withTranscript} -> spoke ${f.dealerSpoke} ` +
            `-> past opener ${f.pastOpener} -> real exchange ${f.meaningfulConversation})`,
    );
    console.log(`  (scored ${f.scored}, of which qualified ${f.qualified})`);
    console.log(
        `  (greeting cut off before the dealer spoke: ${f.greeting.cutOffBeforeDealerSpoke}, ` +
            `median ${f.greeting.medianCutOffSeconds ?? "—"}s)`,
    );
    console.log(
        `  (heard the WHOLE greeting and still said nothing: ${f.greeting.completeThenSilent})`,
    );
    console.log(
        `  (conversation: n=${f.conversation.measured} median ${f.conversation.medianSeconds ?? "—"}s ` +
            `mean ${f.conversation.averageSeconds ?? "—"}s)`,
    );

    // A conversation cannot outnumber the dealers who spoke, and its mean must
    // sit ABOVE the all-calls mean — that gap is the entire reason the metric
    // exists. If it ever inverts, the subset is not the subset it claims to be.
    if (f.conversation.measured <= f.dealerSpoke) {
        ok("conversations never outnumber the dealers who spoke");
    } else {
        bad(
            "conversations never outnumber the dealers who spoke",
            `${f.conversation.measured} > ${f.dealerSpoke}`,
        );
    }

    // The two silences must exactly partition the silent calls. If they ever
    // stop adding up, one of them is double-counting and the split that tells
    // telephony apart from the script is lying.
    const silent = f.withTranscript - f.dealerSpoke;
    const split = f.greeting.cutOffBeforeDealerSpoke + f.greeting.completeThenSilent;
    if (split === silent) {
        ok(`the two silences partition every silent call (${split} = ${silent})`);
    } else {
        bad(
            "the two silences partition every silent call",
            `cutOff ${f.greeting.cutOffBeforeDealerSpoke} + complete ${f.greeting.completeThenSilent} = ${split}, but ${silent} calls were silent`,
        );
    }

    // E-267 status, reported rather than asserted: zero measured is the
    // EXPECTED state until the migration is applied and new calls accrue.
    const turnsColumn = await hasTranscriptTurnsColumn();
    console.log(
        `  (transcript_turns column ${turnsColumn ? "present" : "ABSENT — E-267 unapplied"}; ` +
            `response-time measured on ${f.responseTime.measured} call(s), ` +
            `median ${f.responseTime.medianSecondsBeforeHangUp ?? "—"}s)`,
    );

    const chain: Array<[string, number, string, number]> = [
        ["dialled", f.dialled, "attempted", f.attempted],
        ["answered", f.answered, "dialled", f.dialled],
        ["withTranscript", f.withTranscript, "answered", f.answered],
        ["dealerSpoke", f.dealerSpoke, "withTranscript", f.withTranscript],
        ["pastOpener", f.pastOpener, "dealerSpoke", f.dealerSpoke],
        ["meaningfulConversation", f.meaningfulConversation, "pastOpener", f.pastOpener],
        ["qualified", f.qualified, "scored", f.scored],
    ];
    let monotonic = true;
    for (const [name, value, parentName, parent] of chain) {
        if (value > parent) {
            bad(`${name} never exceeds ${parentName}`, `${value} > ${parent}`);
            monotonic = false;
        }
    }
    if (monotonic) ok("every stage is bounded by the stage above it");

    if (f.greeting.complete + f.greeting.cutOff <= f.withTranscript) {
        ok("greeting states are bounded by the transcript population");
    } else {
        bad(
            "greeting states are bounded by the transcript population",
            `${f.greeting.complete} + ${f.greeting.cutOff} > ${f.withTranscript}`,
        );
    }

    const scriptCalls = f.openingScripts.reduce((s, o) => s + o.calls, 0);
    if (scriptCalls <= f.withTranscript) {
        ok("opening-script calls are bounded by the transcript population");
    } else {
        bad(
            "opening-script calls are bounded by the transcript population",
            `${scriptCalls} > ${f.withTranscript}`,
        );
    }

    if (f.openingScripts.length > 0) {
        console.log("\n  Opening scripts, best reply rate first");
        for (const s of f.openingScripts.slice(0, 6)) {
            const rate = s.calls ? Math.round((s.dealerSpoke / s.calls) * 100) : 0;
            console.log(
                `    n=${String(s.calls).padStart(3)}  replied=${String(rate).padStart(3)}%  ` +
                    `avg=${String(s.averageSeconds ?? "—").padStart(4)}s  "${s.fingerprint}"`,
            );
        }
    }
}

async function perCampaignSection() {
    console.log("\nPer-campaign spot check (largest campaign with calls)");

    const found = Array.from(
        await db.execute(sql`
        SELECT id, name, completed_leads
          FROM dialer_campaigns
         ORDER BY completed_leads DESC, total_leads DESC
         LIMIT 1
    `),
    ) as Array<{ id: string; name: string; completed_leads: number }>;

    const target = found[0];
    if (!target) {
        skip("per-campaign funnel", "no campaigns in this database");
        return;
    }
    console.log(`  (${String(target.name).slice(0, 48)})`);

    const f = buildCallQualityFunnel(await loadCampaignRows(target.id));
    console.log(
        `  attempted ${f.attempted} -> dialled ${f.dialled} -> answered ${f.answered} ` +
            `-> transcript ${f.withTranscript} -> spoke ${f.dealerSpoke}`,
    );
    if (f.answered <= f.attempted) ok("campaign-scoped funnel is internally consistent");
    else bad("campaign-scoped funnel is internally consistent", `answered ${f.answered} > attempted ${f.attempted}`);

    // THE CROSS-CHECK THAT MATTERS MOST.
    //
    // One endpoint serves both halves of this panel, and it does so precisely
    // so they cannot disagree about which calls connected: the histogram's
    // `connectedLeads` comes out of a SQL CTE, the funnel's `answered` comes
    // out of TypeScript, and both are supposed to be the same rule from
    // call-duration/derive. Nothing in the type system makes that true. If they
    // ever drift, the panel shows two different answers to "did this call
    // reach a dealer" one section apart — the exact class of contradiction the
    // Phase 1 duration fix existed to close.
    const buckets = deriveBuckets(DEFAULT_DURATION_BUCKET_CONFIG);
    const histogram = foldDurationHistogram(
        Array.from(
            await db.execute(buildDurationHistogramSql(target.id, buckets)),
        ) as unknown as DurationHistogramRow[],
        buckets,
        { edgesSeconds: [...DEFAULT_DURATION_BUCKET_CONFIG.edgesSeconds], source: "default" },
        target.id,
    );

    if (histogram.totals.connectedLeads === f.answered) {
        ok(`histogram connected ${histogram.totals.connectedLeads} = funnel answered ${f.answered}`);
    } else {
        bad(
            "histogram and funnel agree on which calls connected",
            `histogram says ${histogram.totals.connectedLeads}, funnel says ${f.answered} — ` +
                "call-duration/derive and call-quality/funnel have drifted apart",
        );
    }

    if (histogram.totals.attemptedLeads === f.attempted) {
        ok(`histogram attempted ${histogram.totals.attemptedLeads} = funnel attempted ${f.attempted}`);
    } else {
        bad(
            "histogram and funnel agree on which calls were attempted",
            `histogram says ${histogram.totals.attemptedLeads}, funnel says ${f.attempted}`,
        );
    }
}

async function main() {
    console.log("Verifying AI-dialer call-quality funnel (read-only)");
    await parserSection();
    await funnelSection();
    await perCampaignSection();

    console.log(
        `\n${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`}` +
            (skipped > 0 ? ` — ${skipped} skipped` : ""),
    );
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e?.cause ?? e);
    process.exit(1);
});
