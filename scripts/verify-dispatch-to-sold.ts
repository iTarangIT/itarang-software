// ID 220 — read-only dry run of the daily dispatched → delivered job.
// Lists the sales the job would mark delivered now; changes nothing.
//
//   node --import tsx --env-file=.env.local scripts/verify-dispatch-to-sold.ts

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
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
