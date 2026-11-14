// ID 245 item 3 — one-time catch-up: open leads still at Assigned_Not_Contacted that had a
// PRODUCTIVE visit before 1 Oct 2026 (before visits moved a lead forward on their own, ID
// 114) move to Under_Discussion, with a history line saying why. 24 of Jiten's leads sit at
// Assigned after a productive visit.
//
//   Dry run (default, read-only): the count, per owner, and the leads.
//     node --import tsx --env-file=.env.local scripts/catchup-assigned-visited.ts
//   Apply (live: dry run → post the count → Kartik's go-ahead → backup → apply):
//     node --import tsx --env-file=.env.local scripts/catchup-assigned-visited.ts --apply --actor <admin_user_id>
//
// Each move is a status CORRECTION (event "correction", touchpoint record_correction): it
// writes the history line, is never counted as work and never resets an idle clock.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import type { LeadStatus } from "@/lib/lifecycle/transitions";

const CUTOFF = "2026-10-01";
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const actor = args.includes("--actor") ? args[args.indexOf("--actor") + 1] : null;

type Row = { id: string; dealer: string | null; owner: string | null; visit_date: string; outcome: string };

async function candidates(): Promise<Row[]> {
    return (await db.execute(sql`
        SELECT dl.id, COALESCE(dl.shop_name, dl.dealer_name) AS dealer, u.name AS owner,
               pv.actual_visit_date::text AS visit_date, pv.visit_outcome AS outcome
          FROM dealer_leads dl
          JOIN LATERAL (
              SELECT v.actual_visit_date, v.visit_outcome FROM lead_visits v
               WHERE v.dealer_lead_id = dl.id AND v.visit_status = 'visited'
                 AND v.visit_outcome IN ('productive', 'commercials_progressed')
                 AND v.actual_visit_date < ${CUTOFF}::date
               ORDER BY v.actual_visit_date DESC LIMIT 1
          ) pv ON TRUE
          LEFT JOIN users u ON u.id::text = dl.current_owner_id
         WHERE dl.lead_status = 'Assigned_Not_Contacted' AND dl.is_active IS NOT FALSE
         ORDER BY u.name NULLS LAST, pv.actual_visit_date
    `)) as unknown as Row[];
}

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    console.log(`DB host: ${host || "(unset)"}  ${apply ? "APPLY" : "dry run"}\n`);
    const rows = await candidates();
    console.log(`Open leads at Assigned with a productive visit before ${CUTOFF}: ${rows.length}`);
    const byOwner = new Map<string, number>();
    for (const r of rows) byOwner.set(r.owner ?? "(no owner)", (byOwner.get(r.owner ?? "(no owner)") ?? 0) + 1);
    for (const [k, n] of [...byOwner.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(24)} ${n}`);
    console.log("");
    for (const r of rows.slice(0, 60)) console.log(`  ${r.id.padEnd(30)} ${(r.owner ?? "—").padEnd(18)} visited ${r.visit_date} (${r.outcome})  ${r.dealer ?? ""}`);
    if (rows.length > 60) console.log(`  … and ${rows.length - 60} more`);

    if (!apply) {
        console.log("\nDry run: nothing changed. Add --apply --actor <admin user id> after Kartik's go-ahead.");
        return;
    }
    if (!actor) throw new Error("--actor <admin_user_id> is required with --apply");
    const role = (await db.execute(sql`SELECT role FROM users WHERE id::text = ${actor} AND is_active`)) as unknown as Array<{ role: string }>;
    if (role[0]?.role !== "admin") throw new Error("--actor must be an active admin user id");

    let moved = 0;
    for (const r of rows) {
        await db.transaction(async (tx) => {
            const now = (await tx.execute(sql`SELECT lead_status FROM dealer_leads WHERE id = ${r.id} FOR UPDATE`)) as unknown as Array<{ lead_status: string }>;
            if (now[0]?.lead_status !== "Assigned_Not_Contacted") return; // moved on since the read
            await writeTouchpoint(
                {
                    dealerLeadId: r.id,
                    touchpointType: "record_correction",
                    performedBy: actor,
                    remarks: `Catch-up (ID 245): productive visit on ${r.visit_date} was logged before visits moved a lead forward.`,
                    countsAsWork: false,
                    statusChange: {
                        from: "Assigned_Not_Contacted" as LeadStatus,
                        to: "Under_Discussion" as LeadStatus,
                        event: "correction",
                        reasonNotes: `Catch-up (ID 245): productive visit on ${r.visit_date}; status was left at Assigned.`,
                    },
                },
                { tx },
            );
            moved++;
        });
    }
    console.log(`\nMoved ${moved} lead(s) to Under discussion, each with a history line.`);
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    });
