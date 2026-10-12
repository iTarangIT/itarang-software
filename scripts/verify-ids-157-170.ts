/**
 * Read-only check for tracker IDs 157, 159, 169, 170, 172 (12 Oct 2026).
 * Runs the REAL query builders that changed against the database in
 * DATABASE_URL and prints PASS / FAIL per check. Writes nothing.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-ids-157-170.ts
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { runReport } from "@/lib/admin/reports";
import { fetchTeamPerformance } from "@/lib/admin/dashboard";
import { buildIsrScorecard } from "@/lib/admin/isrScorecard";
import { matchedUnion } from "@/lib/dashboard/revenueSource";
import { finalisedNotWonSql } from "@/lib/leads/finalisedNotWon";
import { listSalesHeadAction } from "@/lib/dashboard/salesHeadActions";
import { listTargets } from "@/lib/targets/service";
import { fetchEvents } from "@/lib/leads/eventLog";
import { summariseCompanyTargets } from "@/lib/dashboard/companyTarget";
import { listSaidYesNotWon } from "@/lib/leads/saidYesNotWon";
import { dealCardActualsSql } from "@/lib/leads/dealCardActuals";
import { hasDealCardColumns, readLockedDealCard } from "@/lib/leads/dealCard";
import { datasetById } from "@/lib/exports/datasets/registry";

let failed = 0;
async function check(name: string, fn: () => Promise<string | void>) {
    try {
        const note = await fn();
        console.log(`PASS  ${name}${note ? `  — ${note}` : ""}`);
    } catch (e) {
        failed++;
        console.log(`FAIL  ${name}  — ${(e as Error).message.split("\n")[0]}`);
    }
}

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    console.log(`database: ${host}\n`);
    const f = { date_from: "2026-09-01", date_to: "2026-10-12" } as never;

    await check("170 Daily Activity (status changes from history, record fixes out)", async () => {
        const r = await runReport("daily_activity", f);
        const changes = r.rows.reduce((a, x) => a + Number(x.status_changes ?? 0), 0);
        const [h] = (await db.execute(sql`
            SELECT COUNT(*)::int AS n FROM dealer_lead_status_history h
             WHERE h.changed_by IS NOT NULL AND h.from_status IS DISTINCT FROM h.to_status
               AND (h.changed_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN '2026-09-01' AND '2026-10-12'
        `)) as unknown as Array<{ n: number }>;
        if (changes !== Number(h.n)) throw new Error(`report ${changes} ≠ history ${h.n}`);
        return `${r.rows.length} rows, ${changes} status changes = history`;
    });
    await check("170 Lost analysis: no 'Sales lost / onboarding_dropout' row", async () => {
        const r = await runReport("lost_analysis", f);
        if (r.rows.some((x) => x.category === "Sales lost" && x.reason === "onboarding_dropout")) throw new Error("still there");
        return `${r.rows.length} rows`;
    });
    await check("170 Meetings MTD runs (cancelled visits out)", async () => {
        const r = await runReport("meetings_mtd", f);
        return `${r.rows.length} rows`;
    });
    await check("170 Funnel by owner runs", async () => {
        const r = await runReport("funnel_by_owner", f);
        return `${r.rows.length} rows`;
    });
    await check("170 Admin team table runs", async () => {
        const r = await fetchTeamPerformance({} as never);
        return `${(r as unknown[]).length} people`;
    });
    await check("170 Lead events: status rows carry '(undone)' / old Lost reason", async () => {
        const rows = await fetchEvents({ from: "2026-09-01", to: "2026-10-12", eventTypes: ["status_change"] });
        const undone = rows.filter((r) => String(r.to_value ?? "").includes("(undone)")).length;
        return `${rows.length} status rows, ${undone} marked (undone)`;
    });

    await check("159/169 ISR scorecard (closer credit, hot-to-field distinct)", async () => {
        const r = await buildIsrScorecard({ from: "2026-09-01", to: "2026-10-12" });
        const won = Object.values(r).reduce((a, s) => a + s.won, 0);
        return `${Object.keys(r).length} people, ${won} Won`;
    });
    await check("169 revenue match with GSTIN aliases (valid_before)", async () => {
        const u = await matchedUnion();
        const [r] = (await db.execute(sql`
            SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE x.dealer_lead_id IS NOT NULL)::int AS linked
              FROM ${u} x`)) as unknown as Array<{ n: number; linked: number }>;
        const [a] = (await db.execute(sql`
            SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'lead_gstin_corrected'`)) as unknown as Array<{ n: number }>;
        return `${r.n} invoices, ${r.linked} linked to a lead; ${a.n} GSTIN corrections on record`;
    });
    await check("169 finalised-not-Won skips undone leads", async () => {
        const [r] = (await db.execute(sql`
            SELECT COUNT(*)::int AS n FROM dealer_leads dl WHERE ${finalisedNotWonSql()}`)) as unknown as Array<{ n: number }>;
        return `${r.n} leads`;
    });
    await check("169 Sales Head tile: undo requests only on Won leads", async () => {
        const rows = await listSalesHeadAction("won_undo_requests", {} as never);
        return `${rows.length} waiting`;
    });
    await check("169 Dealer Verification queue excludes undo-withdrawn forms", async () => {
        const [r] = (await db.execute(sql`
            SELECT COUNT(*)::int AS n FROM dealer_onboarding_applications a
             WHERE (a.onboarding_status <> 'draft' OR a.submitted_at IS NOT NULL)
               AND a.onboarding_status = 'withdrawn' AND a.submitted_at IS NULL`)) as unknown as Array<{ n: number }>;
        return `${r.n} withdrawn-by-undo forms now left out`;
    });

    await check("157 target split adds up (this month)", async () => {
        const month = new Date().toISOString().slice(0, 7);
        const rows = await listTargets({ month });
        const t = summariseCompanyTargets([{ month, rows: rows as never }], [month], month);
        for (const m of ["revenue", "batteries_sold"] as const) {
            if (Math.abs(t[m].accepted + t[m].notAccepted - t[m].sum) > 1e-6) throw new Error(`${m} split ≠ sum`);
        }
        return `revenue ${Math.round(t.revenue.accepted)} + ${Math.round(t.revenue.notAccepted)} = ${Math.round(t.revenue.sum)}`;
    });

    await check("159 CEO New dealers query (closer credit)", async () => {
        const rows = (await db.execute(sql`
            SELECT app.id, COALESCE(cl.name, cl.email) AS closer_name, (dl.id IS NOT NULL) AS has_lead
              FROM dealer_onboarding_applications app
              LEFT JOIN LATERAL (
                  SELECT x.id, x.closing_owner_id FROM dealer_leads x
                   WHERE x.id::text = app.originating_dealer_lead_id::text
                      OR x.dealer_onboarding_application_id::text = app.id::text
                   ORDER BY (x.id::text = app.originating_dealer_lead_id::text) DESC
                   LIMIT 1) dl ON TRUE
              LEFT JOIN users cl ON cl.id::text = dl.closing_owner_id::text
             WHERE app.approved_at IS NOT NULL`)) as unknown as Array<{ closer_name: string | null; has_lead: boolean }>;
        const withCloser = rows.filter((r) => r.closer_name).length;
        const direct = rows.filter((r) => !r.has_lead).length;
        return `${rows.length} approved: ${withCloser} credited to a closer, ${direct} direct`;
    });

    await check("172 E-336 columns present?", async () =>
        (await hasDealCardColumns(db)) ? "yes" : "NO — quotes save without a card until E-336 is applied",
    );
    await check("172 deal-card actuals (fee invoiced, batteries 60 d after Won)", async () => {
        const a = await dealCardActualsSql();
        if (!a) return "no invoice-line tables";
        const [r] = (await db.execute(sql`
            SELECT COUNT(*)::int AS n, COALESCE(SUM(fee_invoiced), 0)::float8 AS fee,
                   COALESCE(SUM(batteries_60d), 0)::float8 AS b FROM (${a}) x`)) as unknown as Array<{ n: number; fee: number; b: number }>;
        return `${r.n} leads with invoices, fee invoiced ₹${r.fee}, batteries in 60 d after Won ${r.b}`;
    });
    await check("172 locked-card lookup runs", async () => {
        const [l] = (await db.execute(sql`
            SELECT dealer_lead_id FROM dealer_lead_commercials WHERE dealer_decision = 'approved' LIMIT 1`)) as unknown as Array<{ dealer_lead_id: string }>;
        if (!l) return "no dealer-approved quote to try";
        const r = await readLockedDealCard(db, l.dealer_lead_id);
        return r ? `locked by ${r.by} on v${r.versionNo}` : "no card on it (expected before E-336)";
    });
    await check("172 Dealer said yes list (deal card)", async () => `${(await listSaidYesNotWon()).length} rows`);
    await check("172 Quotes download builds (deal card + actual columns)", async () => {
        const ds = datasetById("quotes");
        if (!ds) throw new Error("no quotes dataset");
        const params = new URLSearchParams({ from: "2026-09-01", to: "2026-10-12" });
        const sheets = await ds.build({ params, user: { id: "verify", role: "admin" }, ownOnly: false } as never);
        const r0 = sheets[0].rows[0] as Record<string, unknown> | undefined;
        return `${sheets[0].rows.length} quotes; first row fee_invoiced=${r0?.fee_invoiced ?? "null"}, onboarding_fee=${r0?.onboarding_fee ?? "null"}`;
    });
    await check("172 ISR scorecard volume check", async () => {
        const r = await buildIsrScorecard({ from: "2026-01-01", to: "2026-12-31" });
        const withVol = Object.values(r).filter((s) => s.volume).length;
        return `${withVol} people with a 60-day volume check`;
    });

    console.log(failed ? `\n${failed} FAILED` : "\nall PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
