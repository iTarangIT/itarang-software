// Read-only check: is the web process's DB pool being held by background work?
//
// The web server's postgres.js pool is small (src/lib/db/index.ts, max 5) and
// the in-process tickers (instrumentation-node.ts) used to share it. When a
// ticker query ran for tens of seconds, page requests queued behind it — the
// Accounts tab fans out the most requests at once, so it waited longest (> 1
// min). Background work now has its own pool (src/lib/db/background.ts), whose
// connections report as "<app>-bg".
//
// Samples pg_stat_activity a few times (connections per application_name and
// state, oldest running query), then prints the heaviest pg_stat_statements
// entries. Nothing is written.
//
//   node --import tsx --env-file=.env.local scripts/verify-db-pool-contention.ts
//   SAMPLES=12 node --import tsx --env-file=.env.production scripts/verify-db-pool-contention.ts

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

type Activity = { app: string; state: string | null; n: number; max_age_s: number | null; sample: string | null };

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
    console.log(`DB host: ${host}`);
    const samples = Math.max(1, Number(process.env.SAMPLES ?? 6));

    const cap = (await db.execute(sql`SELECT current_setting('max_connections')::int AS max,
        (SELECT count(*)::int FROM pg_stat_activity) AS used`)) as unknown as Array<{ max: number; used: number }>;
    console.log(`connections: ${cap[0]?.used} used of ${cap[0]?.max}`);

    for (let i = 0; i < samples; i++) {
        const rows = (await db.execute(sql`
            SELECT coalesce(nullif(application_name, ''), '(unnamed)') AS app,
                   state,
                   count(*)::int AS n,
                   max(EXTRACT(EPOCH FROM now() - query_start))::int AS max_age_s,
                   left(regexp_replace(max(CASE WHEN state = 'active' THEN query END), '\\s+', ' ', 'g'), 110) AS sample
              FROM pg_stat_activity
             WHERE datname = current_database() AND pid <> pg_backend_pid()
             GROUP BY 1, 2
             ORDER BY 1, 2
        `)) as unknown as Activity[];
        console.log(`\n${new Date().toISOString()}`);
        console.table(rows);
        if (i < samples - 1) await new Promise((r) => setTimeout(r, 10_000));
    }

    try {
        const heavy = await db.execute(sql`
            SELECT calls::int,
                   round(mean_exec_time)::int AS mean_ms,
                   round(max_exec_time)::int  AS max_ms,
                   left(regexp_replace(query, '\\s+', ' ', 'g'), 120) AS query
              FROM pg_stat_statements
             WHERE max_exec_time > 10000
             ORDER BY max_exec_time DESC
             LIMIT 15
        `);
        console.log("\nStatements that have run > 10 s (since stats reset):");
        console.table(heavy);
    } catch (e) {
        console.log(`pg_stat_statements unavailable: ${e instanceof Error ? e.message : e}`);
    }
}

main().then(
    () => process.exit(0),
    (e) => {
        console.error(e);
        process.exit(1);
    },
);
