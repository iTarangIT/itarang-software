// Read-only check for Sales Head › Reports (Analyses, Data downloads, Scheduled
// email reports).
//
// Runs the REAL builders the page calls, then recounts every headline number
// with independent, plain SQL — written here from the column types, never by
// reusing the builders' helpers, so a wrong time-zone conversion in the
// builders cannot hide behind the same mistake here — and fails loudly on any
// difference. Meetings is compared with the Sales Head Ops dashboard's own
// builder (buildSalesDashboard), person by person.
//
//   node --import tsx --env-file=.env.local scripts/verify-reports-analyses.ts
//   node --import tsx --env-file=.env.production scripts/verify-reports-analyses.ts

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { buildSalesDashboard } from "@/lib/admin/salesDashboard";
import { lastDigestSend } from "@/lib/digests/engine";
import { DIGEST_KINDS } from "@/lib/digests/registry";
import { datasetById } from "@/lib/exports/datasets/registry";
import { aiScoreAccuracyByBand, leadSources, meetingsByManagerCity } from "@/lib/reports/analyses";
import type { AnalysisPeriod } from "@/lib/reports/analysesShared";

type Viewer = Parameters<typeof leadSources>[1];
const viewer = { id: "verify-script", role: "sales_head", name: "verify", email: null } as unknown as Viewer;

let failures = 0;
function eq(label: string, got: number, want: number) {
    const ok = got === want;
    if (!ok) failures += 1;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : ` (independent count: ${want})`}`);
}
function checks(list: { label: string; holds: boolean; detail: string }[], findings: string[] = []) {
    for (const c of list) {
        const finding = findings.some((f) => c.label.startsWith(f));
        if (!c.holds && !finding) failures += 1;
        console.log(`  ${c.holds ? "ok  " : finding ? "note" : "FAIL"} check: ${c.label}${c.holds ? "" : ` — ${c.detail}`}`);
    }
}
const one = async (q: SQL) => Number(((await db.execute(q)) as unknown as { n: number }[])[0]?.n ?? 0);

// created_at: timestamp WITHOUT time zone holding UTC. closed_at: timestamptz.
const CREATED_IST = sql`(dl.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date`;
const CLOSED_IST = sql`(dl.closed_at AT TIME ZONE 'Asia/Kolkata')::date`;
const between = (col: SQL, p: AnalysisPeriod) => sql`${col} BETWEEN ${p.from}::date AND ${p.to}::date`;
const HELD = sql`(dl.current_owner_id IS NOT NULL OR dl.closing_owner_id IS NOT NULL)`;

async function checkLeadSources(from?: string, to?: string) {
    for (const group of ["door", "origin", "campaign"] as const) {
        const r = await leadSources({ from, to, group }, viewer);
        const p = r.period;
        console.log(`\nLead sources · ${group} · ${p.from} → ${p.to}`);
        checks(r.checks);
        if (group !== "door") {
            eq(`Leads in (all, by ${group})`, r.total.leads_in, r.rows.reduce((s, x) => s + x.leads_in, 0));
            continue;
        }
        const base = sql`FROM dealer_leads dl WHERE dl.is_active IS NOT FALSE AND ${between(CREATED_IST, p)}`;
        eq("Leads in", r.total.leads_in, await one(sql`SELECT COUNT(*)::int AS n ${base}`));
        eq("Assigned", r.total.assigned, await one(sql`SELECT COUNT(*)::int AS n ${base} AND dl.lead_status IS NOT NULL AND ${HELD}`));
        eq("Converted", r.total.converted, await one(sql`SELECT COUNT(*)::int AS n ${base} AND dl.lead_status = 'Converted' AND ${HELD}`));
        eq("Lost", r.total.lost, await one(sql`SELECT COUNT(*)::int AS n ${base} AND dl.lead_status = 'Lost' AND ${HELD}`));
        eq(
            "Quote sent (reached the dealer)",
            r.total.quote_sent,
            await one(sql`SELECT COUNT(*)::int AS n ${base} AND dl.lead_status IS NOT NULL AND ${HELD}
                AND (EXISTS (SELECT 1 FROM quotation_dispatches q WHERE q.dealer_lead_id = dl.id AND q.status = 'sent')
                  OR EXISTS (SELECT 1 FROM lead_touchpoints t WHERE t.dealer_lead_id = dl.id AND t.touchpoint_type = 'quote_dispatched'))`),
        );
        eq(
            "Called (any human call)",
            r.total.called,
            await one(sql`SELECT COUNT(*)::int AS n ${base} AND dl.lead_status IS NOT NULL AND ${HELD}
                AND EXISTS (SELECT 1 FROM lead_touchpoints t WHERE t.dealer_lead_id = dl.id AND t.touchpoint_type = 'inside_sales_call')`),
        );
        for (const row of r.rows) {
            const door = row.key;
            eq(
                `Leads in · ${row.label}`,
                row.leads_in,
                await one(
                    door == null
                        ? sql`SELECT COUNT(*)::int AS n ${base} AND (to_jsonb(dl) ->> 'source_door') IS NULL`
                        : sql`SELECT COUNT(*)::int AS n ${base} AND (to_jsonb(dl) ->> 'source_door') = ${door}`,
                ),
            );
        }
        const dl = await datasetById("leads")!.count({
            params: new URLSearchParams({ from: p.from, to: p.to, contactability: "include" }),
            user: viewer,
            ownOnly: false,
        });
        eq("Leads download for the same period", dl, r.total.leads_in);
    }
}

async function checkAiScore(from?: string, to?: string) {
    const r = await aiScoreAccuracyByBand({ from, to });
    const p = r.period;
    console.log(`\nAI score accuracy · ${p.from} → ${p.to}`);
    // "Conversion rises with the score" is a finding about the AI, not a report bug.
    checks(r.checks, ["Conversion rises"]);
    const base = sql`FROM dealer_leads dl WHERE dl.is_active IS NOT FALSE AND dl.closed_at IS NOT NULL AND ${between(CLOSED_IST, p)}`;
    eq("Converted (by closed date, IST)", r.total.converted, await one(sql`SELECT COUNT(*)::int AS n ${base} AND dl.lead_status = 'Converted'`));
    eq("Lost (by closed date, IST)", r.total.lost, await one(sql`SELECT COUNT(*)::int AS n ${base} AND dl.lead_status = 'Lost'`));
    eq(
        "Not scored",
        r.rows.find((x) => x.band === "not_scored")!.closed,
        await one(sql`SELECT COUNT(*)::int AS n ${base} AND dl.lead_status IN ('Converted','Lost')
            AND COALESCE(dl.final_intent_score, 0) <= 0 AND dl.intent_band IS NULL`),
    );
}

async function checkMeetings(from?: string, to?: string) {
    const r = await meetingsByManagerCity({ from, to });
    const p = r.period;
    console.log(`\nMeetings · ${p.from} → ${p.to}`);
    checks(r.checks);

    // Every active field person is listed.
    const active = (await db.execute(sql`
        SELECT id::text AS id, name FROM users WHERE role IN ('asm','sales_manager') AND is_active IS TRUE
    `)) as unknown as { id: string; name: string }[];
    const listed = new Set(r.rows.map((x) => x.manager_id));
    const missing = active.filter((a) => !listed.has(a.id));
    eq(`Active ASMs / sales managers listed (of ${active.length})`, active.length - missing.length, active.length);

    // Person by person against the Ops dashboard's own builder.
    const dash = await buildSalesDashboard({ from: p.from, to: p.to, granularity: "day" });
    eq("Visits (all) = Ops dashboard", r.total.visits, dash.totals.visits);
    eq("Dealers visited (all) = Ops dashboard", r.total.dealers, dash.totals.unique_visits);
    const per = new Map<string, { visits: number; dealers: number; fresh: number }>();
    for (const x of r.rows) {
        if (!x.manager_id) continue;
        const a = per.get(x.manager_id) ?? { visits: 0, dealers: 0, fresh: 0 };
        a.visits += x.visits;
        a.dealers += x.dealers;
        a.fresh += x.fresh;
        per.set(x.manager_id, a);
    }
    for (const s of dash.per_spoc ?? []) {
        if (s.totals.visits === 0 && s.totals.unique_visits === 0) continue;
        const mine = per.get(s.spoc_id) ?? { visits: 0, dealers: 0, fresh: 0 };
        const who = s.name ?? s.spoc_id;
        eq(`  ${who}: visits`, mine.visits, s.totals.visits);
        eq(`  ${who}: dealers`, mine.dealers, s.totals.unique_visits);
        eq(`  ${who}: fresh = new dealers`, mine.fresh, s.totals.new_visits);
    }
}

async function checkDownloads() {
    console.log("\nData downloads");
    // The Leads download with an AI filter used to fail on a missing join.
    try {
        const n = await datasetById("leads")!.count({
            params: new URLSearchParams({ ai_band: "Qualified", contactability: "include" }),
            user: viewer,
            ownOnly: false,
        });
        const want = await one(sql`
            SELECT COUNT(*)::int AS n FROM dealer_leads dl
             WHERE dl.is_active IS NOT FALSE
               AND (SELECT a.band FROM ai_call_logs a WHERE a.lead_id = dl.id ORDER BY a.created_at DESC LIMIT 1) = 'Qualified'`);
        eq("Leads download, AI band = Qualified (no error)", n, want);
    } catch (e) {
        failures += 1;
        console.log(`  FAIL Leads download with an AI filter: ${(e as Error).message.split("\n")[0]}`);
    }

    // Customer loan files by submitted date: timestamptz, IST day.
    const [t] = (await db.execute(sql`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS today`)) as unknown as { today: string }[];
    const loanFrom = "2026-01-01";
    const loans = await datasetById("customer_loan_files")!.count({
        params: new URLSearchParams({ from: loanFrom, to: t.today }),
        user: viewer,
        ownOnly: false,
    });
    const wantLoans = await one(sql`
        SELECT COUNT(*)::int AS n FROM (
            SELECT v.lead_id, MIN(COALESCE(v.submitted_at, v.created_at)) AS s
              FROM admin_verification_queue v GROUP BY v.lead_id
        ) q
        JOIN leads l ON l.id::text = q.lead_id
        WHERE (q.s AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${loanFrom}::date AND ${t.today}::date`);
    eq(`Customer loan files submitted ${loanFrom} → today`, loans, wantLoans);
}

async function checkEmails() {
    console.log("\nScheduled email reports · last real send");
    for (const kind of DIGEST_KINDS) {
        const got = await lastDigestSend(kind.id);
        const [want] = (await db.execute(sql`
            SELECT COUNT(*)::int AS n FROM digest_runs WHERE kind = ${kind.id} AND status = 'sent' AND slot <> 'test'
        `)) as unknown as { n: number }[];
        const ok = (got != null) === (Number(want?.n ?? 0) > 0);
        if (!ok) failures += 1;
        console.log(`  ${ok ? "ok  " : "FAIL"} ${kind.id}: ${got ? `${got.sent_at} (for ${got.digest_date})` : "never sent"}${kind.weekdays ? ` · days ${kind.weekdays.join(",")}` : ""}`);
    }
}

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
    console.log(`DB host: ${host}`);
    const [t] = (await db.execute(sql`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS today`)) as unknown as { today: string }[];
    const windows: [string | undefined, string | undefined, string][] = [
        [undefined, undefined, "default"],
        [`${t.today.slice(0, 8)}01`, t.today, "this month"],
        ["2026-01-01", t.today, "this year"],
    ];
    for (const [from, to, name] of windows) {
        console.log(`\n══════════ window: ${name} ══════════`);
        await checkLeadSources(from, to);
        await checkAiScore(from, to);
        await checkMeetings(from, to);
    }
    await checkDownloads();
    await checkEmails();
    console.log(`\n${failures === 0 ? "ALL CHECKS PASS" : `${failures} FAILURE(S)`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
