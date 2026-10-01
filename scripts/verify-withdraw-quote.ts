/**
 * Verifier for tracker ID 78 — Withdraw quote, review of 30 Sep.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-withdraw-quote.ts
 *
 * Runs the REAL writer (withdrawQuote) against whatever DATABASE_URL points at.
 * Read-only: every withdrawal happens inside a transaction that is ALWAYS
 * rolled back. Exit code 1 if anything FAILs; a check SKIPs when the database
 * holds no lead in the shape it needs.
 */
import { and, eq, sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import { dealerLeadCommercials } from "../src/lib/db/schema";
import { WithdrawQuoteError, withdrawQuote } from "../src/lib/leads/withdrawQuote";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Outcome = "PASS" | "FAIL" | "SKIP";
const results: Array<{ id: string; outcome: Outcome; note: string }> = [];
class Rollback extends Error {}

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
async function rolledBack(fn: (tx: Tx) => Promise<void>) {
    try {
        await db.transaction(async (tx) => {
            await fn(tx);
            throw new Rollback();
        });
    } catch (e) {
        if (!(e instanceof Rollback)) throw e;
    }
}

type Pick1 = {
    commercial_id: string;
    dealer_lead_id: string;
    version_no: number;
    lead_status: string | null;
    owner: string | null;
};

const QUOTE = sql`event_type IN ('quote_issue','quote_revision')`;
/** A quote the writer accepts: not withdrawn, not rejected, not dealer-approved, lead not closed. */
const WITHDRAWABLE = sql`
    c.${QUOTE} AND c.withdrawn_at IS NULL
    AND c.approval_status IN ('approved', 'pending')
    AND c.dealer_decision IS DISTINCT FROM 'approved'
    AND dl.lead_status IS DISTINCT FROM 'Won'
    AND dl.lead_status IS DISTINCT FROM 'Converted'
    AND dl.lead_status IS DISTINCT FROM 'Lost'`;
/** Another version of the same lead that is still in play. */
const OTHER_IN_PLAY = sql`
    SELECT 1 FROM dealer_lead_commercials n
     WHERE n.dealer_lead_id = c.dealer_lead_id AND n.${QUOTE}
       AND n.commercial_id <> c.commercial_id
       AND n.approval_status IN ('approved', 'pending') AND n.withdrawn_at IS NULL`;

async function main() {
    await check("withdrawing one version while another is still in play leaves the lead where it is", async () => {
        const [q] = (await db.execute<Pick1>(sql`
            SELECT c.commercial_id::text AS commercial_id, c.dealer_lead_id, c.version_no,
                   dl.lead_status, dl.current_owner_id AS owner
              FROM dealer_lead_commercials c
              JOIN dealer_leads dl ON dl.id = c.dealer_lead_id
             WHERE ${WITHDRAWABLE} AND EXISTS (${OTHER_IN_PLAY})
             ORDER BY c.version_no ASC
             LIMIT 1
        `)) as unknown as Pick1[];
        if (!q) throw new Error("SKIP: no lead with two quote versions in play");
        let note = "";
        await rolledBack(async (tx) => {
            const res = await withdrawQuote(
                { leadId: q.dealer_lead_id, commercialId: q.commercial_id, actorId: q.owner ?? "system", reason: "verify-withdraw-quote (rolled back)" },
                { tx },
            );
            assert(res.leadStatus === q.lead_status, `lead moved ${q.lead_status} → ${res.leadStatus}`);
            const [after] = (await tx.execute<{ lead_status: string | null; withdrawn: boolean }>(sql`
                SELECT dl.lead_status, c.withdrawn_at IS NOT NULL AS withdrawn
                  FROM dealer_lead_commercials c JOIN dealer_leads dl ON dl.id = c.dealer_lead_id
                 WHERE c.commercial_id = ${q.commercial_id}::uuid
            `)) as unknown as Array<{ lead_status: string | null; withdrawn: boolean }>;
            assert(after.withdrawn, "the quote was not marked withdrawn");
            assert(after.lead_status === q.lead_status, `lead row moved to ${after.lead_status}`);
            note = `v${q.version_no} withdrawn; lead stays ${q.lead_status}; live quote: ${res.liveQuote ? `v${res.liveQuote.versionNo}` : "none (a pending revision remains)"}`;
        });
        return note;
    });

    await check("withdrawing the last quote in play sends a commercials-stage lead back to Under discussion", async () => {
        const [q] = (await db.execute<Pick1>(sql`
            SELECT c.commercial_id::text AS commercial_id, c.dealer_lead_id, c.version_no,
                   dl.lead_status, dl.current_owner_id AS owner
              FROM dealer_lead_commercials c
              JOIN dealer_leads dl ON dl.id = c.dealer_lead_id
             WHERE ${WITHDRAWABLE} AND NOT EXISTS (${OTHER_IN_PLAY})
               AND dl.lead_status IN ('Commercials_Explained', 'Awaiting_Customer_Decision')
             LIMIT 1
        `)) as unknown as Pick1[];
        if (!q) throw new Error("SKIP: no commercials-stage lead whose only quote in play can be withdrawn");
        let note = "";
        await rolledBack(async (tx) => {
            const res = await withdrawQuote(
                { leadId: q.dealer_lead_id, commercialId: q.commercial_id, actorId: q.owner ?? "system", reason: "verify-withdraw-quote (rolled back)" },
                { tx },
            );
            assert(res.leadStatus === "Under_Discussion", `expected Under_Discussion, got ${res.leadStatus}`);
            assert(res.liveQuote === null, "a live quote was reported after the last one was withdrawn");
            const [after] = (await tx.execute<{ lead_status: string | null }>(sql`
                SELECT lead_status FROM dealer_leads WHERE id = ${q.dealer_lead_id}
            `)) as unknown as Array<{ lead_status: string | null }>;
            assert(after.lead_status === "Under_Discussion", `lead row is ${after.lead_status}`);
            note = `v${q.version_no}: ${q.lead_status} → Under_Discussion`;
        });
        return note;
    });

    await check("a quote the dealer approved cannot be withdrawn", async () => {
        const [q] = (await db.execute<Pick1>(sql`
            SELECT c.commercial_id::text AS commercial_id, c.dealer_lead_id, c.version_no,
                   dl.lead_status, dl.current_owner_id AS owner
              FROM dealer_lead_commercials c
              JOIN dealer_leads dl ON dl.id = c.dealer_lead_id
             WHERE c.${QUOTE} AND c.withdrawn_at IS NULL AND c.dealer_decision = 'approved'
             LIMIT 1
        `)) as unknown as Pick1[];
        if (!q) throw new Error("SKIP: no dealer-approved quote on this database");
        let refused: string | null = null;
        await rolledBack(async (tx) => {
            try {
                await withdrawQuote(
                    { leadId: q.dealer_lead_id, commercialId: q.commercial_id, actorId: q.owner ?? "system", reason: "verify-withdraw-quote (rolled back)" },
                    { tx },
                );
            } catch (e) {
                if (!(e instanceof WithdrawQuoteError)) throw e;
                refused = e.message;
            }
        });
        assert(refused, "the withdrawal was accepted");
        return `refused: ${refused}`;
    });

    await check("the CEO queue's 'not withdrawn' filter runs and never counts more than plain pending", async () => {
        // The same fragment GET /api/dashboard/ceo/quotations uses (E-314 column, named raw).
        const notWithdrawn = sql`${dealerLeadCommercials}.withdrawn_at IS NULL`;
        const [all] = await db
            .select({ n: sql<number>`COUNT(*)::int` })
            .from(dealerLeadCommercials)
            .where(eq(dealerLeadCommercials.approval_status, "pending"));
        const [open] = await db
            .select({ n: sql<number>`COUNT(*)::int`, any: sql<string | null>`MAX(${dealerLeadCommercials}.withdrawn_at::text)` })
            .from(dealerLeadCommercials)
            .where(and(eq(dealerLeadCommercials.approval_status, "pending"), notWithdrawn));
        assert(Number(open.n) <= Number(all.n), `${open.n} open > ${all.n} pending`);
        assert(open.any === null, "a withdrawn row passed the filter");
        return `${all.n} pending, ${open.n} of them not withdrawn (${Number(all.n) - Number(open.n)} withdrawn quotes leave the queue)`;
    });

    for (const r of results) console.log(`${r.outcome.padEnd(4)}  ${r.id} — ${r.note}`);
    const failed = results.filter((r) => r.outcome === "FAIL").length;
    console.log(`\n${results.length - failed} ok / ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

void main();
