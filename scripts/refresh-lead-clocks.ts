// ID 86 — rebuild lead_clocks for every lead now (the back-fill, and a manual
// run of the hourly lead-clocks ticker). Rewrites only lead_clocks, a derived
// table; the source rows are read, never changed.
//
//   node --import tsx --env-file=.env.local      scripts/refresh-lead-clocks.ts
//   node --import tsx --env-file=.env.production scripts/refresh-lead-clocks.ts
//   … --dry-run   compute and print the figures, write nothing

import { computeLeadClocks, refreshLeadClocks } from "@/lib/leads/clocks";

async function main() {
    const dry = process.argv.includes("--dry-run");
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}${dry ? "  (dry run)" : ""}`);
    const t0 = Date.now();
    if (dry) {
        const clocks = await computeLeadClocks();
        const by = (k: string) => clocks.filter((c) => c.clock === k);
        for (const k of ["lead", "owner", "transfer"]) {
            const c = by(k);
            console.log(
                `${k.padEnd(8)} ${String(c.length).padStart(6)} clocks · attempted ${c.filter((x) => x.first_attempt_at).length}` +
                    ` · limit passed ${c.filter((x) => x.limit_passed_at).length}` +
                    ` · owner inferred ${c.filter((x) => x.owner_inferred).length} · start inferred ${c.filter((x) => x.start_inferred).length}`,
            );
        }
    } else {
        const r = await refreshLeadClocks();
        if (!r) {
            console.log("SKIP  E-337 is not on this database (lead_clocks missing)");
            process.exit(1);
        }
        console.log(`wrote ${r.clocks} clocks, ${r.passed} limit-passed`);
    }
    console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
