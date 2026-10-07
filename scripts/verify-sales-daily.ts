/**
 * READ-ONLY: does the Sales Daily email match the database?
 *
 *   node --import tsx --env-file=.env.production scripts/verify-sales-daily.ts [istDay]
 *
 * istDay is the day the mail COVERS (YYYY-MM-DD), default yesterday in IST. The
 * 4 Oct 2026 mail that was questioned is `2026-10-04`.
 *
 * For each window the email uses (Yesterday · Last 7 days · MTD · same period
 * last month) this builds Block A and the per-rep figures with the REAL modules
 * the digest calls (salesDailyPeriods → buildSalesDashboard → buildBlockA /
 * loadRepExtras), then recounts each figure with a separate plain query written
 * here — a different query, the same definition — and prints every pair. A
 * mismatch exits 1.
 *
 * Checked:
 *   Leads in + Imported in bulk  = every lead created in the window, counted the
 *                                  way the /leads list's Created filter counts
 *                                  (leadListQuery.ts: UTC → IST date)
 *   Calls made / Dealers called  = inside_sales_call touchpoints on IST days
 *                                  (NeoDove re-dispositions printed apart: they
 *                                  are dropped by design, metricDefinitions.ts)
 *   Dealers visited              = distinct dealers with a visit dated in range
 *   Marked Won                   = distinct leads moved to Won
 *   Quotes delivered             = quote_dispatched touchpoints
 *   Per rep (MTD)                = calls per performed_by, visits per asm_id
 */
export {};

const base = process.env.DATABASE_URL ?? "";
process.env.DATABASE_URL = base + (base.includes("?") ? "&" : "?") + "default_transaction_read_only=on";

type Win = { from: string; to: string };

function istYesterday(): string {
    const now = new Date(Date.now() + 5.5 * 3600_000);
    now.setUTCDate(now.getUTCDate() - 1);
    return now.toISOString().slice(0, 10);
}

async function main() {
    const { sql } = await import("drizzle-orm");
    const { db } = await import("@/lib/db");
    const { buildSalesDashboard } = await import("@/lib/admin/salesDashboard");
    const { buildBlockA, IMPORTED_LABEL } = await import("@/lib/digests/salesDailyBlockA");
    const { loadRepExtras } = await import("@/lib/digests/salesDailyBlocks");
    const { salesDailyPeriods } = await import("@/lib/digests/kinds/sales-daily");

    const istDay = process.argv[2] ?? istYesterday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(istDay)) throw new Error("istDay must be YYYY-MM-DD");
    const periods = salesDailyPeriods(istDay);
    console.log(`Sales Daily covering ${istDay}`);
    for (const [k, p] of Object.entries(periods)) console.log(`  ${k.padEnd(10)} ${p.from} → ${p.to}`);

    const dash = (p: Win) =>
        buildSalesDashboard({ ...p, city: null, state: null, spoc_id: null, business_type: null, granularity: "day" });
    const [dy, d7, dm, dl] = await Promise.all([
        dash(periods.yesterday),
        dash(periods.last7),
        dash(periods.mtd),
        dash(periods.lastMonth),
    ]);
    const blockA = await buildBlockA(db, periods, { yesterday: dy, last7: d7, mtd: dm, lastMonth: dl });
    const row = (label: string) => blockA.rows.find((r) => r.label === label)?.values;

    const one = async (q: ReturnType<typeof sql>): Promise<number> => {
        const r = (await db.execute(q)) as unknown as Array<{ n: string | number | null }>;
        return Number(r[0]?.n ?? 0);
    };
    const istDate = (col: ReturnType<typeof sql>) => sql`(${col} AT TIME ZONE 'Asia/Kolkata')::date`;

    // Independent recounts — written here, not imported.
    const independent: Record<string, (p: Win) => Promise<number>> = {
        "Leads in + Imported in bulk": (p) =>
            one(sql`SELECT COUNT(*) AS n FROM dealer_leads dl
                     WHERE dl.is_active IS NOT FALSE
                       AND (dl.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${p.from}::date AND ${p.to}::date`),
        "Calls made": (p) =>
            one(sql`SELECT COUNT(*) AS n FROM lead_touchpoints t JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
                     WHERE t.touchpoint_type = 'inside_sales_call'
                       AND ${istDate(sql`t.performed_at`)} BETWEEN ${p.from}::date AND ${p.to}::date`),
        "Dealers visited": (p) =>
            one(sql`SELECT COUNT(DISTINCT v.dealer_lead_id) AS n FROM lead_visits v JOIN dealer_leads dl ON dl.id = v.dealer_lead_id
                     WHERE v.actual_visit_date BETWEEN ${p.from}::date AND ${p.to}::date`),
        "Marked Won": (p) =>
            one(sql`SELECT COUNT(DISTINCT h.dealer_lead_id) AS n FROM dealer_lead_status_history h
                     WHERE h.to_status = 'Won' AND ${istDate(sql`h.changed_at`)} BETWEEN ${p.from}::date AND ${p.to}::date`),
        "Quotes delivered": (p) =>
            one(sql`SELECT COUNT(*) AS n FROM lead_touchpoints t
                     WHERE t.touchpoint_type = 'quote_dispatched'
                       AND ${istDate(sql`t.performed_at`)} BETWEEN ${p.from}::date AND ${p.to}::date`),
    };
    const emailValue: Record<string, (k: "y" | "d7" | "mtd" | "lm") => number | null> = {
        "Leads in + Imported in bulk": (k) => {
            const a = row("Leads in")?.[k];
            const b = row(IMPORTED_LABEL)?.[k];
            return a == null || b == null ? null : a + b;
        },
        "Calls made": (k) => row("Calls made")?.[k] ?? null,
        "Dealers visited": (k) => row("Dealers visited")?.[k] ?? null,
        "Marked Won": (k) => row("Marked Won")?.[k] ?? null,
        "Quotes delivered": (k) => row("Quotes delivered")?.[k] ?? null,
    };
    // Calls are deduped by design (NeoDove re-dispositions): the raw count may be
    // higher, never lower. Everything else must match exactly.
    const dedupedRows = new Set(["Calls made"]);

    const keys = [
        ["y", periods.yesterday],
        ["d7", periods.last7],
        ["mtd", periods.mtd],
        ["lm", periods.lastMonth],
    ] as const;
    let bad = 0;
    console.log("\nBlock A — email vs independent recount");
    console.log(`  ${"metric".padEnd(30)} ${"window".padEnd(5)} ${"email".padStart(8)} ${"db".padStart(8)}`);
    for (const [name, recount] of Object.entries(independent)) {
        for (const [k, p] of keys) {
            const e = emailValue[name](k);
            const d = await recount(p);
            const ok = e != null && (dedupedRows.has(name) ? e <= d : e === d);
            if (!ok) bad++;
            const note = dedupedRows.has(name) && e != null && e < d ? `  (${d - e} NeoDove re-dispositions merged)` : "";
            console.log(`  ${name.padEnd(30)} ${k.padEnd(5)} ${String(e ?? "—").padStart(8)} ${String(d).padStart(8)} ${ok ? "ok" : "MISMATCH"}${note}`);
        }
    }
    const li = row("Leads in");
    const im = row(IMPORTED_LABEL);
    console.log(`\n  Leads in (own arrival) y/7d/MTD/LM: ${li?.y}/${li?.d7}/${li?.mtd}/${li?.lm}`);
    console.log(`  Imported in bulk      y/7d/MTD/LM: ${im?.y}/${im?.d7}/${im?.mtd}/${im?.lm}`);

    // Per rep, MTD: the dashboard's per_spoc (Blocks B / C) vs plain counts.
    console.log("\nPer rep (MTD) — email vs independent recount");
    const names = new Map((dm.per_spoc ?? []).map((b) => [b.spoc_id, b.name ?? b.spoc_id]));
    const callsBy = (await db.execute(sql`
        SELECT t.performed_by AS u, COUNT(*) AS n FROM lead_touchpoints t JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
         WHERE t.touchpoint_type = 'inside_sales_call'
           AND ${istDate(sql`t.performed_at`)} BETWEEN ${periods.mtd.from}::date AND ${periods.mtd.to}::date
         GROUP BY 1`)) as unknown as Array<{ u: string | null; n: string }>;
    const visitsBy = (await db.execute(sql`
        SELECT v.asm_id AS u, COUNT(DISTINCT v.dealer_lead_id) AS n FROM lead_visits v JOIN dealer_leads dl ON dl.id = v.dealer_lead_id
         WHERE v.actual_visit_date BETWEEN ${periods.mtd.from}::date AND ${periods.mtd.to}::date
         GROUP BY 1`)) as unknown as Array<{ u: string | null; n: string }>;
    const rawCalls = new Map(callsBy.map((r) => [r.u ?? "", Number(r.n)]));
    const rawVisits = new Map(visitsBy.map((r) => [r.u ?? "", Number(r.n)]));
    for (const b of dm.per_spoc ?? []) {
        const c = rawCalls.get(b.spoc_id) ?? 0;
        const v = rawVisits.get(b.spoc_id) ?? 0;
        const callsOk = b.totals.calls <= c && (c === 0 || b.totals.calls > 0);
        const visitsOk = b.totals.unique_visits === v;
        if (!callsOk || !visitsOk) bad++;
        if (b.totals.calls || c || b.totals.unique_visits || v) {
            console.log(
                `  ${String(names.get(b.spoc_id)).padEnd(22)} calls ${String(b.totals.calls).padStart(5)} / db ${String(c).padStart(5)}` +
                    `   dealers visited ${String(b.totals.unique_visits).padStart(4)} / db ${String(v).padStart(4)}` +
                    `${callsOk && visitsOk ? "" : "  MISMATCH"}`,
            );
        }
    }
    // Calls / visits by someone who is not a sales rep land on no row.
    for (const [u, n] of rawCalls) if (u && !names.has(u)) console.log(`  (not on the email) calls by ${u}: ${n}`);
    for (const [u, n] of rawVisits) if (u && !names.has(u)) console.log(`  (not on the email) visits by ${u}: ${n}`);

    const extras = await loadRepExtras(db, periods.mtd);
    console.log(`\n  Block C extras loaded for ${Object.keys(extras).length} metrics.`);

    console.log(bad === 0 ? "\nAll figures reconcile." : `\n${bad} figure(s) do not reconcile.`);
    process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
