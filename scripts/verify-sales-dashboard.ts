// B6 — read-only check of the sales dashboard builder against the live DB.
//
//   node --import tsx --env-file=.env.local scripts/verify-sales-dashboard.ts [--spoc <users.id>] [--city X] [--state Y] [--business_type Z]
//
// 1. Runs buildSalesDashboard() for the last 30 days and prints every section.
// 2. Picks one rep and one day with activity and RE-DERIVES that rep's visits,
//    unique, new and calls for that day with plain SQL written independently
//    of the builder, then compares. A mismatch exits 1.
// 3. Times a 90-day whole-team run (target: under 2 s on sandbox data).
// 4. Confirms an unknown city yields zeros, not an error.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    buildSalesDashboard,
    type SalesDashboard,
    type SalesSeriesRow,
} from "@/lib/admin/salesDashboard";

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

const line = (s = "") => console.log(s);
const pad = (v: unknown, w: number) => String(v).padStart(w);

function printSections(d: SalesDashboard, title: string, maxSeriesRows = 12) {
    line(`── ${title} ──────────────────────────────────────────`);
    line(`as of ${d.as_of_date}  range ${d.filters.from} → ${d.filters.to}  (${d.filters.granularity})`);
    line(`A snapshot   visits yday=${d.snapshot.visits_yesterday}  calls yday=${d.snapshot.calls_yesterday}  planned today=${d.snapshot.planned_visits_today}  next 7d=${d.snapshot.planned_visits_next_7_days}`);
    line(`C averages   /day: visits=${d.averages.avg_visits_per_day} unique=${d.averages.avg_unique_per_day} new=${d.averages.avg_new_per_day} calls=${d.averages.avg_calls_per_day}  (${d.averages.days_in_range} days)`);
    line(`D interest   (ageing on ${d.interest.ageing_basis})`);
    for (const r of d.interest.rows) {
        line(`   ${r.interest_level.padEnd(4)} total=${pad(r.total, 4)}  0-7=${pad(r.age_0_7, 3)}  8-14=${pad(r.age_8_14, 3)}  15-30=${pad(r.age_15_30, 3)}  30+=${pad(r.age_30_plus, 3)}`);
    }
    const active = d.series.filter((r) => r.visits || r.calls);
    line(`B series     ${d.series.length} buckets, ${active.length} with activity (showing up to ${maxSeriesRows} active)`);
    line(`   bucket       visits unique  new  calls`);
    for (const r of active.slice(-maxSeriesRows)) {
        line(`   ${r.bucket}  ${pad(r.visits, 6)} ${pad(r.unique_visits, 6)} ${pad(r.new_visits, 4)} ${pad(r.calls, 6)}`);
    }
}

async function handSql(spoc: string, day: string) {
    const v = await db.execute<{ visits: string; uniq: string; nw: string }>(sql`
        WITH first_visit AS (
            SELECT dealer_lead_id, MIN(actual_visit_date) AS d
              FROM lead_visits WHERE actual_visit_date IS NOT NULL GROUP BY 1
        )
        SELECT COUNT(*)::text AS visits,
               COUNT(DISTINCT v.dealer_lead_id)::text AS uniq,
               COUNT(DISTINCT v.dealer_lead_id) FILTER (WHERE fv.d = v.actual_visit_date)::text AS nw
          FROM lead_visits v
          LEFT JOIN first_visit fv ON fv.dealer_lead_id = v.dealer_lead_id
         WHERE v.asm_id = ${spoc} AND v.actual_visit_date = ${day}::date
    `);
    const c = await db.execute<{ calls: string }>(sql`
        SELECT COUNT(*)::text AS calls
          FROM lead_touchpoints t
         WHERE t.performed_by = ${spoc}
           AND t.touchpoint_type IN ('inside_sales_call', 'ai_call')
           AND (t.performed_at AT TIME ZONE 'Asia/Kolkata')::date = ${day}::date
    `);
    const r = (v as unknown as { visits: string; uniq: string; nw: string }[])[0]!;
    return {
        visits: Number(r.visits),
        unique_visits: Number(r.uniq),
        new_visits: Number(r.nw),
        calls: Number((c as unknown as { calls: string }[])[0]!.calls),
    };
}

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
    line(`DB host: ${host}`);

    const common = {
        city: arg("city") ?? null,
        state: arg("state") ?? null,
        business_type: arg("business_type") ?? null,
        granularity: "day" as const,
    };

    // 1. Last 30 days, whole team (or the pinned rep).
    const t0 = Date.now();
    const d = await buildSalesDashboard({ ...common, spoc_id: arg("spoc") ?? null });
    line(`built in ${Date.now() - t0} ms`);
    printSections(d, arg("spoc") ? `rep ${arg("spoc")}` : "whole team");

    if (d.per_spoc) {
        line(`E per rep    ${d.per_spoc.length} rep(s) with activity`);
        for (const s of d.per_spoc) {
            line(`   ${(s.name ?? s.spoc_id).padEnd(28)} [${s.role ?? "?"}]  visits/day=${s.averages.avg_visits_per_day} calls/day=${s.averages.avg_calls_per_day}  hot=${s.interest.rows[0]!.total} warm=${s.interest.rows[1]!.total} cold=${s.interest.rows[2]!.total}`);
        }
    }

    // 2. Cross-check one rep on one day against independent SQL.
    line();
    let failed = false;
    const pick =
        (d.per_spoc ?? [])
            .flatMap((s) =>
                s.series
                    .filter((r: SalesSeriesRow) => r.visits > 0 || r.calls > 0)
                    .map((r) => ({ spoc: s.spoc_id, name: s.name, row: r })),
            )
            // Prefer a day that has BOTH visits and calls, then the busiest.
            .sort(
                (a, b) =>
                    Number(b.row.visits > 0 && b.row.calls > 0) - Number(a.row.visits > 0 && a.row.calls > 0) ||
                    b.row.visits + b.row.calls - (a.row.visits + a.row.calls),
            )[0] ?? null;

    if (!pick) {
        line("cross-check: no rep had any visit or call in the last 30 days — nothing to compare");
    } else {
        const hand = await handSql(pick.spoc, pick.row.bucket);
        const builder = {
            visits: pick.row.visits,
            unique_visits: pick.row.unique_visits,
            new_visits: pick.row.new_visits,
            calls: pick.row.calls,
        };
        const ok = JSON.stringify(hand) === JSON.stringify(builder);
        line(`cross-check  ${pick.name ?? pick.spoc} on ${pick.row.bucket}`);
        line(`   builder  ${JSON.stringify(builder)}`);
        line(`   hand SQL ${JSON.stringify(hand)}`);
        line(`   ${ok ? "MATCH" : "MISMATCH"}`);
        if (!ok) failed = true;
    }

    // 3. 90-day timing.
    const t1 = Date.now();
    const ninety = await buildSalesDashboard({
        ...common,
        spoc_id: null,
        from: (() => { const x = new Date(`${d.as_of_date}T00:00:00Z`); x.setUTCDate(x.getUTCDate() - 89); return x.toISOString().slice(0, 10); })(),
        to: d.as_of_date,
    });
    const ms = Date.now() - t1;
    line();
    line(`90-day whole-team run: ${ms} ms, ${ninety.series.length} daily buckets, ${ninety.per_spoc?.length ?? 0} reps  ${ms < 2000 ? "(under 2 s)" : "(OVER 2 s)"}`);

    // 4. Unknown city → zeros, not an error.
    const nowhere = await buildSalesDashboard({ ...common, spoc_id: null, city: "Nowhere-" + Date.now() });
    const allZero =
        nowhere.snapshot.visits_yesterday === 0 &&
        nowhere.series.every((r) => r.visits === 0 && r.calls === 0) &&
        nowhere.interest.rows.every((r) => r.total === 0) &&
        (nowhere.per_spoc?.length ?? 0) === 0;
    line(`unknown city: ${allZero ? "all zeros, no error" : "NOT all zeros"}`);
    if (!allZero) failed = true;

    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
