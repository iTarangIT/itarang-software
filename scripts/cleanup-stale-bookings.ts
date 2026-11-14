// ID 247 item 3 — one open booking per lead: keep the NEWEST open booking (status scheduled
// / pending_scheduling, by when it was booked) and cancel the older ones with the remark
// "replaced by the visit on <date>", the date being the kept booking's. The same booking
// lib/asm/nextBooking.ts already shows as "Next visit".
//
//   Dry run (default, read-only): how many leads have more than one open booking, how many
//   bookings would close, per owner; and the 247 test leads.
//     node --import tsx --env-file=.env.local scripts/cleanup-stale-bookings.ts
//     node --import tsx --env-file=.env.local scripts/cleanup-stale-bookings.ts --owner Jiten
//   Apply (live: dry run → post the counts → Kartik's go-ahead → backup → apply):
//     node --import tsx --env-file=.env.local scripts/cleanup-stale-bookings.ts --apply
//
// Planned-visit counts drop by exactly the closed stale bookings: nothing else is touched.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { replacedByVisitRemark } from "@/lib/asm/recordVisit";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const ownerArg = args.includes("--owner") ? args[args.indexOf("--owner") + 1] : null;
const TEST_LEADS = ["Adnan", "Devendra pal", "Bharat power system"];

type Stale = { visit_id: string; lead_id: string; dealer: string | null; owner: string | null; scheduled_date: string | null; kept_date: string | null };

async function stale(): Promise<Stale[]> {
    return (await db.execute(sql`
        WITH open AS (
            SELECT v.visit_id, v.dealer_lead_id, v.scheduled_date, v.created_at,
                   row_number() OVER (PARTITION BY v.dealer_lead_id ORDER BY v.created_at DESC, v.scheduled_date DESC NULLS LAST) AS rn,
                   first_value(v.scheduled_date) OVER (PARTITION BY v.dealer_lead_id ORDER BY v.created_at DESC, v.scheduled_date DESC NULLS LAST) AS kept_date,
                   first_value(v.created_at) OVER (PARTITION BY v.dealer_lead_id ORDER BY v.created_at DESC, v.scheduled_date DESC NULLS LAST) AS kept_created
              FROM lead_visits v
             WHERE v.visit_status IN ('scheduled', 'pending_scheduling') AND v.dealer_lead_id IS NOT NULL
        )
        SELECT o.visit_id::text AS visit_id, o.dealer_lead_id AS lead_id,
               COALESCE(dl.shop_name, dl.dealer_name) AS dealer, u.name AS owner,
               o.scheduled_date::text AS scheduled_date,
               COALESCE(o.kept_date, (o.kept_created AT TIME ZONE 'Asia/Kolkata')::date)::text AS kept_date
          FROM open o
          JOIN dealer_leads dl ON dl.id = o.dealer_lead_id
          LEFT JOIN users u ON u.id::text = dl.current_owner_id
         WHERE o.rn > 1
           ${ownerArg ? sql`AND u.name ILIKE ${`%${ownerArg}%`}` : sql``}
         ORDER BY u.name NULLS LAST, o.dealer_lead_id, o.scheduled_date
    `)) as unknown as Stale[];
}

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    console.log(`DB host: ${host || "(unset)"}  ${apply ? "APPLY" : "dry run"}${ownerArg ? `  owner ~ ${ownerArg}` : ""}\n`);

    const rows = await stale();
    const leads = new Set(rows.map((r) => r.lead_id));
    console.log(`Leads with more than one open booking: ${leads.size}`);
    console.log(`Older open bookings that would close: ${rows.length}\n`);
    const byOwner = new Map<string, { leads: Set<string>; n: number }>();
    for (const r of rows) {
        const k = r.owner ?? "(no owner)";
        const g = byOwner.get(k) ?? { leads: new Set(), n: 0 };
        g.leads.add(r.lead_id);
        g.n++;
        byOwner.set(k, g);
    }
    for (const [k, g] of [...byOwner.entries()].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(24)} leads ${String(g.leads.size).padStart(4)}   bookings to close ${g.n}`);

    console.log("\n247 test leads (open bookings now; the newest is kept):");
    for (const name of TEST_LEADS) {
        const r = (await db.execute(sql`
            SELECT COALESCE(dl.shop_name, dl.dealer_name) AS dealer,
                   string_agg(COALESCE(v.scheduled_date::text, 'no date') || ' (booked ' || to_char(v.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon') || ')', ', ' ORDER BY v.created_at DESC) AS bookings
              FROM dealer_leads dl
              LEFT JOIN lead_visits v ON v.dealer_lead_id = dl.id AND v.visit_status IN ('scheduled', 'pending_scheduling')
             WHERE COALESCE(dl.shop_name, dl.dealer_name) ILIKE ${`%${name}%`}
             GROUP BY 1 LIMIT 3
        `)) as unknown as Array<{ dealer: string; bookings: string | null }>;
        if (!r.length) console.log(`  ${name}: not on this database`);
        for (const x of r) console.log(`  ${x.dealer}: ${x.bookings ?? "no open booking"}`);
    }

    if (!apply) {
        console.log("\nDry run: nothing changed. Add --apply after Kartik's go-ahead (and a backup).");
        return;
    }
    let closed = 0;
    await db.transaction(async (tx) => {
        for (const r of rows) {
            const res = (await tx.execute(sql`
                UPDATE lead_visits
                   SET visit_status = 'cancelled',
                       visit_remarks = concat_ws(' · ', NULLIF(visit_remarks, ''), ${replacedByVisitRemark(r.kept_date ?? "")}::text),
                       updated_at = NOW()
                 WHERE visit_id::text = ${r.visit_id} AND visit_status IN ('scheduled', 'pending_scheduling')
                RETURNING 1 AS x
            `)) as unknown as unknown[];
            closed += res.length;
        }
    });
    console.log(`\nClosed ${closed} older open bookings. Each lead now has one open booking.`);
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    });
