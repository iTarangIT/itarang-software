// Read-only check for Sales Head › Reports › Analyses (6 Oct 2026).
//
// Runs the REAL builders (src/lib/reports/analyses.ts) the page calls, then
// recounts every headline number with independent, plain SQL and fails loudly
// on any difference. Also ties the analyses to the downloads behind their
// "Download these …" buttons (the Leads and Visits datasets), counted by the
// real dataset code.
//
//   node --import tsx --env-file=.env.local scripts/verify-reports-analyses.ts
//   node --import tsx --env-file=.env.production scripts/verify-reports-analyses.ts

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { aiScoreAccuracyByBand, leadSources, meetingsByManagerCity } from "@/lib/reports/analyses";
import { datasetById } from "@/lib/exports/datasets/registry";
import type { AnalysisPeriod } from "@/lib/reports/analysesShared";

type Viewer = Parameters<typeof leadSources>[1];
const viewer = { id: "verify-script", role: "sales_head", name: "verify", email: null } as unknown as Viewer;

let failures = 0;
function eq(label: string, got: number, want: number) {
    const ok = got === want;
    if (!ok) failures += 1;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : ` (independent count: ${want})`}`);
}
const one = async (q: ReturnType<typeof sql>) =>
    Number(((await db.execute(q)) as unknown as { n: number }[])[0]?.n ?? 0);

const IST_CREATED = sql`(dl.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date`;
const IST_CLOSED = sql`(dl.closed_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date`;
const between = (col: ReturnType<typeof sql>, p: AnalysisPeriod) => sql`${col} BETWEEN ${p.from}::date AND ${p.to}::date`;

async function checkLeadSources(from?: string, to?: string) {
    for (const group of ["door", "origin", "campaign"] as const) {
        const r = await leadSources({ from, to, group }, viewer);
        const p = r.period;
        console.log(`\nLead sources · ${group} · ${p.from} → ${p.to}`);
        for (const c of r.checks) {
            if (!c.holds) failures += 1;
            console.log(`  ${c.holds ? "ok  " : "FAIL"} check: ${c.label}${c.holds ? "" : ` — ${c.detail}`}`);
        }
        if (group !== "door") continue;

        const base = sql`FROM dealer_leads dl WHERE dl.is_active IS NOT FALSE AND ${between(IST_CREATED, p)}`;
        eq("Leads in (all)", r.total.leads_in, await one(sql`SELECT COUNT(*)::int AS n ${base}`));
        eq("Converted (all)", r.total.converted, await one(sql`SELECT COUNT(*)::int AS n ${base} AND dl.lead_status = 'Converted'`));
        eq(
            "Lost (all, had an owner)",
            r.total.lost,
            await one(sql`SELECT COUNT(*)::int AS n ${base} AND dl.lead_status = 'Lost'
                AND (dl.current_owner_id IS NOT NULL OR dl.assigned_at IS NOT NULL OR dl.closing_owner_id IS NOT NULL)`),
        );
        eq(
            "Not with sales yet (all)",
            r.total.not_with_sales,
            await one(sql`SELECT COUNT(*)::int AS n ${base} AND NOT (dl.lead_status IS NOT NULL
                AND (dl.current_owner_id IS NOT NULL OR dl.assigned_at IS NOT NULL OR dl.closing_owner_id IS NOT NULL))`),
        );
        for (const row of r.rows) {
            const door = row.key;
            const want = await one(
                door == null
                    ? sql`SELECT COUNT(*)::int AS n ${base} AND (to_jsonb(dl) ->> 'source_door') IS NULL`
                    : sql`SELECT COUNT(*)::int AS n ${base} AND (to_jsonb(dl) ->> 'source_door') = ${door}`,
            );
            eq(`Leads in · ${row.label}`, row.leads_in, want);
        }

        // The "Download these leads" button: same period, dead numbers included.
        const leadsDs = datasetById("leads")!;
        const dl = await leadsDs.count({
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
    for (const c of r.checks) {
        // "Conversion rises with the score" is a finding about the AI, not a
        // bug in the report: shown, but not counted as a failure here.
        const isFinding = c.label.startsWith("Conversion rises");
        if (!c.holds && !isFinding) failures += 1;
        console.log(`  ${c.holds ? "ok  " : isFinding ? "note" : "FAIL"} check: ${c.label}${c.holds ? "" : ` — ${c.detail}`}`);
    }
    const base = sql`FROM dealer_leads dl WHERE dl.is_active IS NOT FALSE AND dl.closed_at IS NOT NULL AND ${between(IST_CLOSED, p)}`;
    eq("Converted (all bands)", r.total.converted, await one(sql`SELECT COUNT(*)::int AS n ${base} AND dl.lead_status = 'Converted'`));
    eq("Lost (all bands)", r.total.lost, await one(sql`SELECT COUNT(*)::int AS n ${base} AND dl.lead_status = 'Lost'`));
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
    for (const c of r.checks) {
        if (!c.holds) failures += 1;
        console.log(`  ${c.holds ? "ok  " : "FAIL"} check: ${c.label}${c.holds ? "" : ` — ${c.detail}`}`);
    }
    const base = sql`FROM lead_visits v WHERE COALESCE(v.actual_visit_date, v.scheduled_date) BETWEEN ${p.from}::date AND ${p.to}::date`;
    eq("Meetings", r.total.meetings, await one(sql`SELECT COUNT(*)::int AS n ${base}`));
    eq("Done (visited)", r.total.done, await one(sql`SELECT COUNT(*)::int AS n ${base} AND v.visit_status = 'visited'`));

    const visitsDs = datasetById("visits")!;
    const dl = await visitsDs.count({
        params: new URLSearchParams({ from: p.from, to: p.to, date_field: "visit" }),
        user: viewer,
        ownOnly: false,
    });
    eq("Visits download for the same period", dl, r.total.meetings);
}

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
    console.log(`DB host: ${host}`);
    const [t] = (await db.execute(sql`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS today`)) as unknown as { today: string }[];
    const windows: [string | undefined, string | undefined, string][] = [
        [undefined, undefined, "default"],
        [`${t.today.slice(0, 8)}01`, t.today, "this month"],
        ["2020-01-01", t.today, "all time"],
    ];
    for (const [from, to, name] of windows) {
        console.log(`\n══════════ window: ${name} ══════════`);
        await checkLeadSources(from, to);
        await checkAiScore(from, to);
        await checkMeetings(from, to);
    }
    console.log(`\n${failures === 0 ? "ALL CHECKS PASS" : `${failures} FAILURE(S)`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
