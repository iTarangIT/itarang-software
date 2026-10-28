// ID 85 / runbook L2 — clear the "Limit passed" records that are wrong on the
// live database, then record them again under today's rules and calls.
//
// Two kinds of wrong record in lead_limit_events:
//   1. every miss that fell due on or after 16 Oct: NeoDove sent no call to
//      live from 6 Oct until the 23 Oct replay, so the hourly job recorded
//      misses on leads that WERE called. The replay does not remove them,
//      because a record is never updated (recordLimitEvents: ON CONFLICT DO
//      NOTHING).
//   2. lead-wide misses charged to a person (clock 'lead', owner_id set): since
//      24 Oct the lead-wide clock is a team figure, never charged to anyone
//      (clockRules.ts chargeTo), but records written before that still count
//      against people in "Limits passed".
// Deleting them and running the clock refresh re-records each miss that still
// stands, with the calls and the rules as they are now. Misses that the
// replayed calls answered do not come back.
//
// Dry run by default: prints the database, what would go, and each person's
// "Limits passed" this month before and after (the "after" is computed, not
// written). --apply writes a JSON backup of every row first, deletes them in
// one transaction and runs the refresh. On the live database --apply also
// needs --confirm-live.
//
//   node --import tsx --env-file=.env.local      scripts/cleanup-limit-events-l2.ts
//   node --import tsx --env-file=.env.production scripts/cleanup-limit-events-l2.ts
//   node --import tsx --env-file=.env.production scripts/cleanup-limit-events-l2.ts --apply --confirm-live
//   … --since=2026-10-16   change the cut-off day (IST)
//
// Then: scripts/verify-id85-86-time-limits.ts on the same database.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { computeLeadClocks, refreshLeadClocks, storableClockKinds } from "@/lib/leads/clocks";

type Row = {
    id: string;
    dealer_lead_id: string;
    clock: string;
    clock_started_at: string;
    limit_key: string;
    limit_value: string;
    limit_unit: string;
    passed_at: string;
    owner_id: string | null;
    owner_inferred: boolean;
    recorded_at: string;
};

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

const since = value("since") ?? "2026-10-16";
if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error("--since must be YYYY-MM-DD");
const cutoff = `${since} 00:00:00+05:30`;
const apply = flag("apply");

/** The rows L2 removes. */
const doomed = sql`(e.passed_at >= ${cutoff}::timestamptz OR (e.clock = 'lead' AND e.owner_id IS NOT NULL))`;

function istMonthStart(d = new Date()): Date {
    const ist = new Date(d.getTime() + 330 * 60_000);
    return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - 330 * 60_000);
}

async function main() {
    const host = new URL(process.env.DATABASE_URL ?? "postgres://unset").host;
    const live = /database-2/i.test(host);
    console.log(`DB host: ${host}${live ? "  (LIVE)" : ""}  · cut-off ${cutoff}  · ${apply ? "APPLY" : "dry run"}`);
    if (apply && live && !flag("confirm-live")) {
        throw new Error("this is the live database: add --confirm-live to --apply (after Kartik's go-ahead)");
    }

    const exists = (await db.execute(sql`SELECT to_regclass('public.lead_limit_events') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
    if (!exists[0]?.ok) {
        console.log("SKIP  E-350 (lead_limit_events) is not on this database");
        process.exit(1);
    }

    const all = (await db.execute(sql`
        SELECT e.id::text, e.dealer_lead_id, e.clock, e.clock_started_at::text, e.limit_key, e.limit_value::text,
               e.limit_unit, e.passed_at::text, e.owner_id, e.owner_inferred, e.recorded_at::text,
               ${doomed} AS doomed
          FROM lead_limit_events e
    `)) as unknown as Array<Row & { doomed: boolean }>;
    const gone = all.filter((r) => r.doomed);
    const kept = all.filter((r) => !r.doomed);

    console.log(`\nlead_limit_events: ${all.length} rows; ${gone.length} to clear, ${kept.length} kept`);
    const byClock = new Map<string, { since: number; charged: number }>();
    for (const r of gone) {
        const c = byClock.get(r.clock) ?? { since: 0, charged: 0 };
        if (new Date(r.passed_at) >= new Date(cutoff)) c.since++;
        else c.charged++;
        byClock.set(r.clock, c);
    }
    for (const [clock, c] of [...byClock].sort()) {
        console.log(`  ${clock.padEnd(14)} ${String(c.since).padStart(5)} since ${since}   ${String(c.charged).padStart(5)} older lead-wide misses charged to a person`);
    }

    // What the refresh would record again, without writing: the computed
    // misses not already held by a kept row (same lead, clock and start).
    const clocks = await computeLeadClocks(new Date(), { kinds: await storableClockKinds() });
    const keyOf = (lead: string, clock: string, started: string | Date) => `${lead}|${clock}|${new Date(started).toISOString()}`;
    const keptKeys = new Set(kept.map((r) => keyOf(r.dealer_lead_id, r.clock, r.clock_started_at)));
    const again = clocks.filter(
        (c) => c.limit_passed_at && c.limit_key && c.limit_value != null && !keptKeys.has(keyOf(c.dealer_lead_id, c.clock, c.started_at)),
    );
    console.log(`  the refresh would record ${again.length} again (misses that still stand under today's calls and rules)`);

    // Each person's "Limits passed" this month (guessed owners left out), before and after.
    const month = istMonthStart();
    const tally = (rows: Array<{ owner_id: string | null; owner_inferred: boolean; passed_at: string | Date }>) => {
        const m = new Map<string, number>();
        for (const r of rows) {
            if (!r.owner_id || r.owner_inferred || new Date(r.passed_at) < month) continue;
            m.set(r.owner_id, (m.get(r.owner_id) ?? 0) + 1);
        }
        return m;
    };
    const before = tally(all);
    const after = tally([
        ...kept,
        ...again.map((c) => ({ owner_id: c.owner_id, owner_inferred: c.owner_inferred, passed_at: c.limit_passed_at! })),
    ]);
    const ids = [...new Set([...before.keys(), ...after.keys()])];
    const names = ids.length
        ? new Map(
              ((await db.execute(sql`
                  SELECT id::text AS id, COALESCE(name, email) AS name FROM users
                   WHERE id::text IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
              `)) as unknown as Array<{ id: string; name: string }>).map((u) => [u.id, u.name]),
          )
        : new Map<string, string>();
    console.log(`\n"Limits passed" this month per person (from ${new Date(month.getTime() + 330 * 60_000).toISOString().slice(0, 10)} IST): before → after`);
    for (const id of ids.sort((a, b) => (before.get(b) ?? 0) - (before.get(a) ?? 0))) {
        console.log(`  ${(names.get(id) ?? id).padEnd(28)} ${String(before.get(id) ?? 0).padStart(5)} → ${after.get(id) ?? 0}`);
    }

    if (!apply) {
        console.log("\nDry run: nothing written. Add --apply to clear and re-record.");
        process.exit(0);
    }

    // Back up, then delete, under the refresh's own lock so the hourly job
    // cannot record in between. The refresh runs after the commit (it takes
    // the same lock in its own transaction).
    const dir = join(process.cwd(), "reports");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `l2-limit-events-backup-${host.split(".")[0]}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    const removed = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('lead_clocks_refresh'))`);
        const rows = (await tx.execute(sql`SELECT e.* FROM lead_limit_events e WHERE ${doomed}`)) as unknown as Row[];
        writeFileSync(file, JSON.stringify({ host, cutoff, taken_at: new Date().toISOString(), rows }, null, 1));
        await tx.execute(sql`DELETE FROM lead_limit_events e WHERE ${doomed}`);
        return rows.length;
    });
    console.log(`\nbacked up ${removed} rows → ${file}`);
    console.log(`cleared ${removed} rows`);

    const r = await refreshLeadClocks();
    console.log(r ? `refresh: ${r.clocks} clocks, ${r.passed} past a limit, ${r.recorded} "Limit passed" records written` : "refresh skipped: E-337 missing");
    console.log("\nNext: scripts/verify-id85-86-time-limits.ts on this database.");
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
