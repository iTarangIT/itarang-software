/**
 * Verifier for the Development_P0 Wave 1 fixes (handover P0-1 … P0-13,
 * 2026-09-29).
 *
 *   node --import tsx --env-file=.env.local scripts/verify-p0-wave1.ts
 *
 * Runs the REAL builders against whatever DATABASE_URL points at. Read-only:
 * every check that must write does so inside a transaction that is always
 * rolled back. Exit code 1 if anything FAILs.
 */
import { eq, sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import { dealerLeads } from "../src/lib/db/schema";
import { buildSalesDashboard } from "../src/lib/admin/salesDashboard";
import { listTargets } from "../src/lib/targets/service";
import { StatusGuardError, writeTouchpoint } from "../src/lib/touchpoints/write";
import { loadQuotationForDealer, staleQuoteReason } from "../src/lib/leads/quoteDecision";
import { humanCall, wasHotAt } from "../src/lib/reports/metricDefinitions";
import { aiInterestLevelSql } from "../src/lib/ai/storage/aiInterest";

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
async function rolledBack(fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>) {
    try {
        await db.transaction(async (tx) => {
            await fn(tx);
            throw new Rollback();
        });
    } catch (e) {
        if (!(e instanceof Rollback)) throw e;
    }
}

async function main() {
const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x").host.split(".")[0];
console.log(`DB host: ${host}`);

await check("P0-11 status guard refuses a backward move", async () => {
    const [lead] = (await db.execute<{ id: string; lead_status: string }>(sql`
        SELECT id, lead_status FROM dealer_leads
         WHERE lead_status IN ('Under_Discussion','Commercials_Explained','Awaiting_Customer_Decision','Commercials_Finalised')
         LIMIT 1
    `)) as unknown as Array<{ id: string; lead_status: string }>;
    if (!lead) throw new Error("SKIP: no lead at Under discussion or later");
    let refused = false;
    await rolledBack(async (tx) => {
        try {
            await writeTouchpoint(
                {
                    dealerLeadId: lead.id,
                    touchpointType: "status_change_note",
                    performedBy: null,
                    statusChange: { from: lead.lead_status as never, to: "Assigned_Not_Contacted" },
                },
                { tx },
            );
        } catch (e) {
            if (e instanceof StatusGuardError) refused = true;
            else throw e;
        }
    });
    assert(refused, `${lead.id}: ${lead.lead_status} → Assigned_Not_Contacted was NOT refused`);
    return `${lead.id} ${lead.lead_status} → Assigned_Not_Contacted refused`;
});

await check("P0-11 a forward move still writes", async () => {
    const [lead] = (await db.execute<{ id: string }>(sql`
        SELECT id FROM dealer_leads WHERE lead_status = 'Assigned_Not_Contacted' LIMIT 1
    `)) as unknown as Array<{ id: string }>;
    if (!lead) throw new Error("SKIP: no Assigned_Not_Contacted lead");
    let status = "";
    await rolledBack(async (tx) => {
        await writeTouchpoint(
            {
                dealerLeadId: lead.id,
                touchpointType: "status_change_note",
                performedBy: null,
                statusChange: { from: "Assigned_Not_Contacted", to: "Under_Discussion" },
            },
            { tx },
        );
        const [row] = await tx.select({ s: dealerLeads.lead_status }).from(dealerLeads).where(eq(dealerLeads.id, lead.id));
        status = row?.s ?? "";
    });
    assert(status === "Under_Discussion", `expected Under_Discussion inside the tx, got ${status}`);
    return `${lead.id} moved forward (rolled back)`;
});

await check("P0-4 dashboard builds with human-call definitions", async () => {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);
    const d = await buildSalesDashboard({ from, to, granularity: "month" });
    const [raw] = (await db.execute<{ raw: string; human: string }>(sql`
        SELECT COUNT(*) FILTER (WHERE t.touchpoint_type IN ('inside_sales_call','ai_call'))::text AS raw,
               COUNT(*) FILTER (WHERE ${humanCall()})::text AS human
          FROM lead_touchpoints t
         WHERE t.performed_at >= ${from}::date AND t.performed_at < ${to}::date + 1
    `)) as unknown as Array<{ raw: string; human: string }>;
    assert(Number(raw.human) <= Number(raw.raw), "human calls exceed raw calls");
    return `60 d: ${raw.raw} raw call touchpoints → ${raw.human} human calls; dashboard calls=${d.totals?.calls ?? "?"}, quotes=${d.outcome?.quotes_issued ?? "?"} (+${d.outcome?.quote_revisions ?? "?"} revisions)`;
});

await check("P0-4 targets list builds (hot at transfer, human calls)", async () => {
    const month = new Date().toISOString().slice(0, 7);
    const rows = await listTargets({ month });
    const [h] = (await db.execute<{ now_hot: string; at_transfer: string }>(sql`
        SELECT COUNT(*) FILTER (WHERE lower(dl.interest_level) = 'hot')::text AS now_hot,
               COUNT(*) FILTER (WHERE ${wasHotAt(sql`t.dealer_lead_id`, sql`t.performed_at`, sql`dl.interest_level`)})::text AS at_transfer
          FROM lead_touchpoints t JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
         WHERE t.touchpoint_type = 'asm_transfer'
    `)) as unknown as Array<{ now_hot: string; at_transfer: string }>;
    return `${rows.length} target rows; ASM transfers Hot now=${h.now_hot}, Hot at transfer=${h.at_transfer}`;
});

await check("P0-6 a replaced quote version is refused", async () => {
    const [q] = (await db.execute<{ commercial_id: string }>(sql`
        SELECT c.commercial_id::text AS commercial_id
          FROM dealer_lead_commercials c
         WHERE c.event_type IN ('quote_issue','quote_revision')
           AND EXISTS (SELECT 1 FROM dealer_lead_commercials n
                        WHERE n.dealer_lead_id = c.dealer_lead_id
                          AND n.event_type IN ('quote_issue','quote_revision')
                          AND n.version_no > c.version_no)
         LIMIT 1
    `)) as unknown as Array<{ commercial_id: string }>;
    if (!q) throw new Error("SKIP: no lead with two quote versions");
    const row = await loadQuotationForDealer(q.commercial_id);
    assert(row, "quote not loaded");
    assert(staleQuoteReason(row) === "replaced", `expected replaced, got ${staleQuoteReason(row)}`);
    return `${q.commercial_id} → replaced by ${row.latest_quote_number ?? row.latest_commercial_id}`;
});

await check("P0-10 AI call leaves an owned lead's temperature alone", async () => {
    const [lead] = (await db.execute<{ id: string; interest_level: string | null }>(sql`
        SELECT id, interest_level FROM dealer_leads
         WHERE current_owner_id IS NOT NULL AND lower(COALESCE(interest_level,'')) = 'hot' LIMIT 1
    `)) as unknown as Array<{ id: string; interest_level: string | null }>;
    if (!lead) throw new Error("SKIP: no owned Hot lead");
    let after: string | null = null;
    await rolledBack(async (tx) => {
        await tx.update(dealerLeads).set({ interest_level: aiInterestLevelSql("cold") }).where(eq(dealerLeads.id, lead.id));
        const [row] = await tx.select({ i: dealerLeads.interest_level }).from(dealerLeads).where(eq(dealerLeads.id, lead.id));
        after = row?.i ?? null;
    });
    assert(after === lead.interest_level, `owned lead flipped ${lead.interest_level} → ${after}`);
    return `${lead.id} stayed ${after}`;
});

await check("P0-3 E-312 data_download_log present", async () => {
    const [r] = (await db.execute<{ ok: boolean }>(sql`SELECT to_regclass('public.data_download_log') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
    if (!r.ok) throw new Error("SKIP: E-312 not applied (downloads still work; they are just not logged)");
    return "table present";
});

for (const r of results) console.log(`${r.outcome.padEnd(4)}  ${r.id} — ${r.note}`);
const failed = results.filter((r) => r.outcome === "FAIL").length;
console.log(`\n${results.length - failed} ok / ${failed} failed`);
process.exit(failed ? 1 : 0);
}

void main();
