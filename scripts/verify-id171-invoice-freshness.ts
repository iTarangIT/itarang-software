// Read-only check of ID 171: "Invoices read up to <date>" and the gap alert.
//
//   node --import tsx --env-file=.env.local scripts/verify-id171-invoice-freshness.ts
//
// 1. read_up_to = the latest non-void invoice date in the revenue union the
//    CEO Revenue figure reads (matchedUnion, credit notes excluded).
// 2. working days since the last new invoice was read = the SQL office-calendar
//    count (workingDaysSinceSql), and stale = that ≥ the invoice_stale_days limit.
// 3. Prints whether the Admin alert would fire today and whether it already did.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { matchedUnion, REVENUE_NOT_VOID } from "@/lib/dashboard/revenueSource";
import { workingDaysSinceSql } from "@/lib/calendar/holidays";
import { invoiceFreshness, staleAlertText } from "@/lib/sales/invoiceFreshness";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}

async function main() {
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}\n`);
    const f = await invoiceFreshness({ fresh: true });
    console.log(`      ${JSON.stringify(f)}`);

    const union = await matchedUnion();
    const [u] = (await db.execute(sql`
        SELECT MAX(r.invoice_date)::text AS d FROM ${union} AS r WHERE ${REVENUE_NOT_VOID} AND r.source <> 'credit'
    `)) as unknown as Array<{ d: string | null }>;
    check(`read up to ${f.read_up_to} = revenue union's latest invoice ${u?.d?.slice(0, 10) ?? null}`, f.read_up_to === (u?.d?.slice(0, 10) ?? null));

    if (f.last_read_at) {
        const [w] = (await db.execute(sql`SELECT ${workingDaysSinceSql(sql`${f.last_read_at}::timestamptz`)} AS n`)) as unknown as Array<{ n: number }>;
        check(`working days since last read: TS ${f.working_days_since_read} = SQL ${w.n}`, Number(w.n) === f.working_days_since_read);
    }
    check(`stale (${f.stale}) = days ≥ limit ${f.stale_after}`, f.stale === (f.working_days_since_read == null || f.working_days_since_read >= f.stale_after));

    const [sent] = (await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM digest_runs
         WHERE kind = 'invoice_stale' AND digest_date = (now() AT TIME ZONE 'Asia/Kolkata')::date
    `)) as unknown as Array<{ n: number }>;
    console.log(`      Admin alert today: ${f.stale ? `due — "${staleAlertText(f)}"` : "not due (fresh)"}; already sent today: ${sent.n > 0 ? "yes" : "no"}`);

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
