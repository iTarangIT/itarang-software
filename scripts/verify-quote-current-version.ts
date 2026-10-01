/**
 * Verifier for tracker ID 60 — "the latest quote" is the newest APPROVED,
 * NOT-WITHDRAWN quote version, for both the dealer's answer and the rep's send.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-quote-current-version.ts
 *
 * Runs the REAL loaders (loadQuotationForDealer, loadQuote) against whatever
 * DATABASE_URL points at. Read-only: SELECTs only. Exit code 1 if anything FAILs.
 * A check SKIPs when the database holds no lead in the shape it needs.
 */
import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import { loadQuotationForDealer, staleQuoteReason } from "../src/lib/leads/quoteDecision";
import { loadQuote } from "../src/lib/leads/quoteSendGate";

type Outcome = "PASS" | "FAIL" | "SKIP";
const results: Array<{ id: string; outcome: Outcome; note: string }> = [];

async function check(id: string, fn: () => Promise<string>) {
    try {
        results.push({ id, outcome: "PASS", note: await fn() });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push({ id, outcome: msg.startsWith("SKIP") ? "SKIP" : "FAIL", note: msg });
    }
}
function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(msg);
}

type Pick1 = { commercial_id: string; dealer_lead_id: string; version_no: number };
const QUOTE = sql`event_type IN ('quote_issue','quote_revision')`;

async function main() {
    await check("an approved version with a newer approved, not-withdrawn version is replaced", async () => {
        const [q] = (await db.execute<Pick1>(sql`
            SELECT c.commercial_id::text AS commercial_id, c.dealer_lead_id, c.version_no
              FROM dealer_lead_commercials c
             WHERE c.${QUOTE} AND c.approval_status = 'approved' AND c.withdrawn_at IS NULL
               AND EXISTS (SELECT 1 FROM dealer_lead_commercials n
                            WHERE n.dealer_lead_id = c.dealer_lead_id AND n.${QUOTE}
                              AND n.approval_status = 'approved' AND n.withdrawn_at IS NULL
                              AND n.version_no > c.version_no)
             LIMIT 1
        `)) as unknown as Pick1[];
        if (!q) throw new Error("SKIP: no lead with two approved, not-withdrawn quote versions");
        const [answer, send] = await Promise.all([
            loadQuotationForDealer(q.commercial_id),
            loadQuote(q.dealer_lead_id, q.commercial_id),
        ]);
        assert(answer && send, "quote not loaded");
        assert(staleQuoteReason(answer) === "replaced", `answer gate: expected replaced, got ${staleQuoteReason(answer)}`);
        assert((answer.latest_version_no ?? 0) > q.version_no, "the current version is not newer than the replaced one");
        assert(send.is_latest_quote === false, "send gate still treats the replaced version as latest");
        return `v${q.version_no} → replaced by v${answer.latest_version_no} (${answer.latest_quote_number ?? "no number"})`;
    });

    await check("a newer version that is pending / rejected / withdrawn replaces nothing", async () => {
        const [q] = (await db.execute<Pick1 & { newer: string }>(sql`
            SELECT c.commercial_id::text AS commercial_id, c.dealer_lead_id, c.version_no,
                   (SELECT string_agg('v' || n.version_no || ' ' ||
                                      CASE WHEN n.withdrawn_at IS NOT NULL THEN 'withdrawn'
                                           ELSE COALESCE(n.approval_status, 'undecided') END, ', ')
                      FROM dealer_lead_commercials n
                     WHERE n.dealer_lead_id = c.dealer_lead_id AND n.${QUOTE}
                       AND n.version_no > c.version_no) AS newer
              FROM dealer_lead_commercials c
             WHERE c.${QUOTE} AND c.approval_status = 'approved' AND c.withdrawn_at IS NULL
               AND EXISTS (SELECT 1 FROM dealer_lead_commercials n
                            WHERE n.dealer_lead_id = c.dealer_lead_id AND n.${QUOTE}
                              AND n.version_no > c.version_no)
               AND NOT EXISTS (SELECT 1 FROM dealer_lead_commercials n
                                WHERE n.dealer_lead_id = c.dealer_lead_id AND n.${QUOTE}
                                  AND n.approval_status = 'approved' AND n.withdrawn_at IS NULL
                                  AND n.version_no > c.version_no)
             LIMIT 1
        `)) as unknown as Array<Pick1 & { newer: string }>;
        if (!q) throw new Error("SKIP: no approved quote sits under a newer pending / rejected / withdrawn version");
        const [answer, send] = await Promise.all([
            loadQuotationForDealer(q.commercial_id),
            loadQuote(q.dealer_lead_id, q.commercial_id),
        ]);
        assert(answer && send, "quote not loaded");
        assert(staleQuoteReason(answer) === null, `answer gate refuses it: ${staleQuoteReason(answer)}`);
        assert(answer.latest_commercial_id === q.commercial_id, "the current version is not this one");
        assert(send.is_latest_quote === true, "send gate refuses to re-send it");
        return `v${q.version_no} is still current; newer: ${q.newer}`;
    });

    await check("the answer gate and the send gate agree on every approved, not-withdrawn quote", async () => {
        const rows = (await db.execute<Pick1>(sql`
            SELECT c.commercial_id::text AS commercial_id, c.dealer_lead_id, c.version_no
              FROM dealer_lead_commercials c
             WHERE c.${QUOTE} AND c.approval_status = 'approved' AND c.withdrawn_at IS NULL
             ORDER BY c.created_at DESC
             LIMIT 150
        `)) as unknown as Pick1[];
        if (rows.length === 0) throw new Error("SKIP: no approved quotes on this database");
        let current = 0;
        for (const q of rows) {
            const [answer, send] = await Promise.all([
                loadQuotationForDealer(q.commercial_id),
                loadQuote(q.dealer_lead_id, q.commercial_id),
            ]);
            assert(answer && send, `${q.commercial_id} not loaded`);
            const answerable = staleQuoteReason(answer) === null;
            assert(
                answerable === (send.is_latest_quote === true),
                `${q.commercial_id}: answerable=${answerable} but is_latest_quote=${send.is_latest_quote}`,
            );
            // Every lead with a live quote has exactly one current version.
            assert(answer.latest_commercial_id, `${q.commercial_id}: a live quote exists but no current version was named`);
            if (answerable) current++;
        }
        return `${rows.length} quotes checked: ${current} current, ${rows.length - current} replaced`;
    });

    for (const r of results) console.log(`${r.outcome.padEnd(4)}  ${r.id} — ${r.note}`);
    const failed = results.filter((r) => r.outcome === "FAIL").length;
    console.log(`\n${results.length - failed} ok / ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

void main();
