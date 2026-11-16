// ID 224 item 2 — one-time fix: a lead NeoDove created must not start AFTER
// its own first call. NeoDove's events reach us about an hour after the call,
// and the lead used to be stamped with the arrival time (182 such leads on live
// at the 10 Nov check). New leads are dated at the call now (src/lib/neodove/
// inbound.ts); this moves the old ones back: the lead's created_at and its
// "Lead created" line go to the time of its first call.
//
// Only leads born in NeoDove (source 'neodove') — a lead we made keeps its own
// created time. "First call" = the earliest touchpoint that is not the
// lead_created line itself.
//
// Dry run by default: prints the database and the count. --apply writes a JSON
// backup of every row it changes first (reports/), then updates in one
// transaction. On the live database --apply also needs --confirm-live (after
// Kartik's go-ahead). Re-running is a no-op.
//
//   node --import tsx --env-file=.env.local scripts/fix-id224-neodove-created-at.ts
//   node --import tsx --env-file=.env.production scripts/fix-id224-neodove-created-at.ts --apply --confirm-live

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

const args = process.argv.slice(2);
const apply = args.includes("--apply");

// dealer_leads.created_at is timestamp WITHOUT time zone holding UTC; the node
// driver would read it as local time, so every time comes back as text (UTC).
type Row = { id: string; created_at: string; first_event_at: string; gap_min: number; lead_created_tp: string | null; lead_created_at: string | null };

// The leads created after their own first event, with what they move to.
const AFFECTED = sql`
    WITH first_ev AS (
        SELECT t.dealer_lead_id, min(t.performed_at) AS first_event_at
          FROM lead_touchpoints t
          JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
         WHERE dl.source = 'neodove' AND t.touchpoint_type <> 'lead_created'
         GROUP BY t.dealer_lead_id
    )
    SELECT dl.id, dl.created_at::text AS created_at,
           (f.first_event_at AT TIME ZONE 'UTC')::text AS first_event_at,
           round(extract(epoch FROM (dl.created_at - (f.first_event_at AT TIME ZONE 'UTC'))) / 60)::int AS gap_min,
           lc.touchpoint_id::text AS lead_created_tp, (lc.performed_at AT TIME ZONE 'UTC')::text AS lead_created_at
      FROM dealer_leads dl
      JOIN first_ev f ON f.dealer_lead_id = dl.id
      LEFT JOIN LATERAL (
            SELECT touchpoint_id, performed_at FROM lead_touchpoints
             WHERE dealer_lead_id = dl.id AND touchpoint_type = 'lead_created'
             ORDER BY performed_at LIMIT 1
      ) lc ON true
     WHERE dl.source = 'neodove' AND dl.created_at > (f.first_event_at AT TIME ZONE 'UTC')
     ORDER BY dl.created_at
`;

async function main() {
    const host = new URL(process.env.DATABASE_URL ?? "postgres://unset").host;
    const live = /database-2/.test(host);
    console.log(`DB host: ${host}${live ? "  (LIVE)" : ""}  · ${apply ? "APPLY" : "dry run"}`);
    if (apply && live && !args.includes("--confirm-live")) {
        throw new Error("this is the live database: add --confirm-live to --apply (after Kartik's go-ahead)");
    }

    const rows = (await db.execute<Row>(AFFECTED)) as unknown as Row[];
    const total = (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM dealer_leads WHERE source = 'neodove'`)) as unknown as { n: number }[];
    const gaps = rows.map((r) => Number(r.gap_min));
    const median = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;
    console.log(`NeoDove-born leads: ${total[0]?.n ?? 0}; created after their own first event: ${rows.length} (median gap ${Math.round(median)} min)`);
    for (const r of rows.slice(0, 10)) {
        console.log(`  ${r.id}  created ${r.created_at} UTC  first event ${r.first_event_at} UTC  (+${r.gap_min} min)`);
    }
    if (rows.length > 10) console.log(`  … and ${rows.length - 10} more`);

    if (!apply) {
        console.log("\nDry run: nothing written. Post the count in the tracker row; add --apply to fix.");
        process.exit(0);
    }
    if (rows.length === 0) {
        console.log("\nNothing to fix.");
        process.exit(0);
    }

    const dir = join(process.cwd(), "reports");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `id224-neodove-created-at-backup-${host.split(".")[0]}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify({ host, taken_at: new Date().toISOString(), rows }, null, 1));
    console.log(`\nbacked up ${rows.length} rows → ${file}`);

    await db.transaction(async (tx) => {
        for (const r of rows) {
            // first_event_at is UTC text: written as-is into the naive UTC column.
            const at = r.first_event_at;
            await tx.execute(sql`
                UPDATE dealer_leads SET created_at = ${at}::timestamp
                 WHERE id = ${r.id} AND source = 'neodove' AND created_at > ${at}::timestamp
            `);
            if (r.lead_created_tp) {
                await tx.execute(sql`
                    UPDATE lead_touchpoints SET performed_at = (${at}::timestamp AT TIME ZONE 'UTC')
                     WHERE touchpoint_id::text = ${r.lead_created_tp} AND performed_at > (${at}::timestamp AT TIME ZONE 'UTC')
                `);
            }
        }
    });
    const left = (await db.execute<Row>(AFFECTED)) as unknown as Row[];
    console.log(`moved ${rows.length} leads back to their first call; left: ${left.length}`);
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
