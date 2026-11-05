// ID 220 — read-only dry run of the daily dispatched → delivered job.
// Lists the sales the job would mark delivered now, and what past daily runs
// moved; changes nothing.
//
//   node --import tsx --env-file=.env.local scripts/verify-dispatch-to-sold.ts

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { runDispatchToSold } from "@/lib/sales/dispatchToSold";

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    console.log(`DB host: ${host || "(unset)"}`);
    const r = await runDispatchToSold({ dryRun: true });
    console.log(`Delay: ${r.dispatchToSoldDays} day(s); dispatched before ${r.cutoff}`);
    console.log(`Would mark delivered: ${r.leadsProcessed.length}`);
    for (const id of r.leadsProcessed.slice(0, 50)) console.log(`  ${id}`);
    if (r.leadsProcessed.length > 50) console.log(`  … and ${r.leadsProcessed.length - 50} more`);
    console.log(`Skipped (no battery serial on the latest selection): ${r.skippedNoSerial.length}`);

    // ID 220 (4 Nov ask): what the daily runs already did — how many sales each
    // day's run moved, and the delivery notices the job sent. Customer SMS are
    // not stored in the database: count them in the pm2 log
    // (grep "cron-delivered-" in itarang-crm-web's out log).
    const runs = (await db.execute(sql`
        SELECT digest_date::text AS day, status, attempts, counts, error
          FROM digest_runs
         WHERE kind = 'dispatch_to_sold'
         ORDER BY digest_date DESC
         LIMIT 30
    `)) as unknown as Array<{ day: string; status: string; attempts: number; counts: Record<string, number> | null; error: string | null }>;
    console.log(`
Daily runs recorded: ${runs.length}`);
    for (const run of runs) {
        const c = run.counts ?? {};
        console.log(
            `  ${run.day}  ${run.status.padEnd(8)} moved ${c.moved ?? "—"}, failed ${c.failed ?? "—"}, ` +
                `no serial ${c.skipped_no_serial ?? "—"}${run.error ? `  error: ${run.error}` : ""}`,
        );
    }
    const totalMoved = runs.reduce((a, run) => a + Number(run.counts?.moved ?? 0), 0);
    console.log(`Total moved by the daily job: ${totalMoved}`);
    const notices = (await db.execute(sql`
        SELECT created_at::date::text AS day, count(*)::int AS n
          FROM notifications
         WHERE type = 'delivery_confirmed' AND data->>'source' = 'cron'
         GROUP BY 1 ORDER BY 1 DESC LIMIT 30
    `).catch(() => [])) as unknown as Array<{ day: string; n: number }>;
    console.log(`Delivery notices sent by the job (dealer bell): ${notices.reduce((a, n) => a + n.n, 0)}`);
    for (const n of notices) console.log(`  ${n.day}  ${n.n}`);
    console.log("Customer SMS: not recorded in the database; count 'cron-delivered-' lines in the live pm2 log.");
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
