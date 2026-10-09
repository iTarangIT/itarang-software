// Read-only check for the CEO headline tiles' "% of target" (Revenue,
// Batteries to dealers). Runs the REAL targets service (listTargets, the one
// /api/admin/targets returns) through the page's rule
// (src/lib/dashboard/companyTarget.ts) for each period chip, and prints what
// each tile's pill would say. The actuals are passed in by hand from the
// screen, since they come from separate reports.
//
//   node --import tsx --env-file=.env.local scripts/verify-ceo-company-targets.ts [revenueFY] [batteriesFY]

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { listTargets } from "@/lib/targets/service";
import { summariseCompanyTargets, targetVerdict } from "@/lib/dashboard/companyTarget";

const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
    console.log(`DB host: ${host}`);
    const today = ((await db.execute(sql`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)) as unknown as Array<{ d: string }>)[0].d;
    const now = new Date(`${today}T12:00:00`);
    const y = now.getFullYear();
    const m = now.getMonth();
    const fyFirst = new Date(m >= 3 ? y : y - 1, 3, 1);
    const fy: string[] = [];
    for (let d = new Date(fyFirst); d <= now; d.setMonth(d.getMonth() + 1)) fy.push(ym(d));
    const periods: Record<string, string[]> = {
        "This month": [ym(now)],
        "Last month": [ym(new Date(y, m - 1, 1))],
        Quarter: Array.from({ length: (m % 3) + 1 }, (_, i) => ym(new Date(y, m - (m % 3) + i, 1))),
        "Financial year": fy,
    };
    const actualRevenueFY = process.argv[2] ? Number(process.argv[2]) : null;
    const actualBatteriesFY = process.argv[3] ? Number(process.argv[3]) : null;

    for (const [label, months] of Object.entries(periods)) {
        const lists = await Promise.all(months.map(async (month) => ({ month, rows: await listTargets({ month }) })));
        const t = summariseCompanyTargets(lists, months, ym(now));
        console.log(`\n${label}  (${months.join(", ")})`);
        for (const metric of ["revenue", "batteries_sold"] as const) {
            const actual = label === "Financial year" ? (metric === "revenue" ? actualRevenueFY : actualBatteriesFY) : null;
            const v = targetVerdict(t[metric], actual, months, ym(now));
            console.log(`  ${metric.padEnd(15)} sum=${Math.round(t[metric].sum)}  missing=[${t[metric].missing.join(", ")}]  →`, JSON.stringify(v));
        }
    }
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
