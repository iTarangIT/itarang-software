// 4 Nov sheet (Aditya tab) — read-only checks of the build on a database:
// IDs 227, 220, 201, 212, 222, 223/224. Writes nothing and sends nothing.
//
//   node --import tsx --env-file=.env.local scripts/verify-04nov.ts
//
// Pass `--prod` style env (.env.production) to run it against db-2.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

const line = (s = "") => console.log(s);
const head = (s: string) => line(`\n── ${s} ${"─".repeat(Math.max(0, 70 - s.length))}`);

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    line(`DB host: ${host}`);

    // ── 227: the job list, what runs it, last run ──
    head("ID 227 · Ops Console > Jobs");
    const { getScheduledJobsReport } = await import("@/lib/operations/scheduledJobsStatus");
    const report = await getScheduledJobsReport();
    line(`scheduled_job_state (E-372) present: ${report.stateTable ? "yes" : "NO — apply drizzle/E-372 first"}`);
    const byHealth = new Map<string, number>();
    for (const j of report.jobs) byHealth.set(j.health, (byHealth.get(j.health) ?? 0) + 1);
    line(`${report.jobs.length} jobs: ${[...byHealth.entries()].map(([h, n]) => `${h} ${n}`).join(", ")}`);
    for (const j of report.jobs) {
        const last = j.lastFinishedAt ? new Date(j.lastFinishedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "—";
        line(`  ${j.health.padEnd(8)} ${j.title.padEnd(52)} ${j.schedule.padEnd(20)} last ${last}${j.dailyDate ? ` · day ${j.dailyDate} ${j.dailyStatus}` : ""}`);
    }

    // ── 227: what the new tickers would find (no writes) ──
    head("ID 227 · new runners, what they would touch");
    const [devices] = (await db.execute(sql`
        SELECT count(*)::int AS n, max(last_seen)::text AS newest FROM iot_devices`)) as unknown as Array<{ n: number; newest: string | null }>;
    const { feedAlive } = await import("@/lib/iot/alerts/offlineScanTick");
    line(`iot-offline-scan: ${devices.n} devices, newest seen ${devices.newest ?? "never"} → ${devices.n && feedAlive(devices.newest ? new Date(devices.newest) : null, new Date()) ? "scans" : "skips (feed not alive)"}`);
    const [costs] = (await db.execute(sql`
        SELECT count(*)::int AS n FROM ai_call_logs
         WHERE cost_fetched_at IS NULL AND call_id IS NOT NULL AND ended_at IS NOT NULL
           AND ended_at < now() - interval '5 minutes' AND provider IN ('bolna', 'elevenlabs')`)) as unknown as Array<{ n: number }>;
    line(`call-cost-backfill: ${costs.n} AI calls with no cost yet (100 per run)`);
    const nbfc = (await db.execute(sql`
        SELECT (SELECT count(*) FROM nbfc_loans)::int AS loans,
               (SELECT max(computed_at)::text FROM borrower_risk_scores) AS last_cds`).catch(() => [{ loans: -1, last_cds: "n/a" }])) as unknown as Array<{ loans: number; last_cds: string | null }>;
    line(`nbfc-nightly: ${nbfc[0]?.loans} loans; last CDS score ${nbfc[0]?.last_cds ?? "never"}`);

    // ── 220 ──
    head("ID 220 · dispatched → delivered");
    const { nextAutoDeliveredAt } = await import("@/lib/sales/dispatchToSoldSchedule");
    const disp = (await db.execute(sql`
        SELECT linked_lead_id, dispatch_date::text AS d FROM inventory
         WHERE status = 'dispatched' AND dispatch_date IS NOT NULL ORDER BY dispatch_date LIMIT 5`)) as unknown as Array<{ linked_lead_id: string; d: string }>;
    for (const r of disp) line(`  ${r.linked_lead_id}: dispatched ${r.d} → marked delivered ${nextAutoDeliveredAt(new Date(r.d), 1).toISOString()}`);
    if (!disp.length) line("  no dispatched sale waiting");

    // ── 201 ──
    head("ID 201 · DigiLocker expired lines the sweep would write (dry run)");
    const { runDigilockerExpirySweep } = await import("@/lib/kyc/digilockerExpirySweep");
    const sweep = await runDigilockerExpirySweep({ dryRun: true });
    line(`main borrower: ${sweep.main}, co-borrower: ${sweep.coBorrower}`);

    // ── 212 ──
    head("ID 212 · Missed Callbacks email (built, not sent)");
    const { missedCallbacksDigest } = await import("@/lib/digests/kinds/missed-callbacks");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    const mc = await missedCallbacksDigest.collect(today);
    if (!mc.ok) line(`FAILED: ${mc.error}`);
    for (const b of mc.figures.backlog) line(`  ${b.label}: ${b.value}`);
    for (const r of mc.figures.tables?.[0]?.rows.slice(0, 10) ?? []) line(`  ${r.join(" | ")}`);
    const audience = await missedCallbacksDigest.audience!.resolve();
    line(`recipients from roles / reporting lines: ${audience.length}`);

    // ── 222 ──
    head("ID 222 · Waiting for a field visit: booked visits");
    const { listSalesHeadAction } = await import("@/lib/dashboard/salesHeadActions");
    const rows = await listSalesHeadAction("visit_overdue", {});
    const booked = rows.filter((r) => r.visit_booked);
    line(`${rows.length} waiting; ${booked.length} with a visit booked; ${rows.length - booked.length} with none`);
    for (const r of booked.slice(0, 5)) line(`  ${r.dealer}: ${r.detail}`);
    const gr = rows.find((r) => /GR ENTERPRISE/i.test(r.dealer));
    if (gr) line(`  GR ENTERPRISE: ${gr.detail}`);

    // ── 223 / 224 ──
    head("IDs 223 / 224 · downloads");
    const { datasetById } = await import("@/lib/exports/datasets/registry");
    const { effectiveRange, istToday } = await import("@/lib/exports/datasets/range");
    const { atOnceLimit, EXCEL_ROW_CAP } = await import("@/lib/exports/datasets/types");
    const [admin] = (await db.execute(sql`
        SELECT id::text AS id, name, email, role FROM users WHERE role = 'admin' AND is_active ORDER BY created_at LIMIT 1`)) as unknown as Array<Record<string, string>>;
    for (const id of ["leads", "customer_loan_files", "visits", "calls"]) {
        const ds = datasetById(id)!;
        const run = { params: new URLSearchParams(), user: admin as never, ownOnly: false, teamIds: [] as string[] };
        const n = await ds.count(run);
        line(
            `  ${id.padEnd(20)} ${String(n).padStart(6)} rows · ${effectiveRange(ds, {}, istToday()).text}` +
                `${n > EXCEL_ROW_CAP ? " · Excel greyed" : ""}${n > atOnceLimit(ds) ? " · emailed" : ""}`,
        );
    }
    const calls = await datasetById("calls")!.build({ params: new URLSearchParams({ from: "2026-10-01" }), user: admin as never, ownOnly: false, teamIds: [] });
    const ai = calls[0].rows.filter((r) => r.channel === "AI dialler");
    line(`  calls since 1 Oct: ${calls[0].rows.length}; AI ${ai.length}, of which with a recording link ${ai.filter((r) => r.recording_url).length}`);

    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
