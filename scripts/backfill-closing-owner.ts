/**
 * One-off correction for tracker ID 117 / handover P0-13 (2026-09-29).
 *
 *   node --import tsx --env-file=.env.local scripts/backfill-closing-owner.ts          # dry run
 *   node --import tsx --env-file=.env.local scripts/backfill-closing-owner.ts --apply  # write
 *
 * Until 29 Sep, writeTouchpoint stamped closing_owner_id with whoever pressed
 * Mark Converted / Mark Lost — an admin closing a rep's lead took the credit.
 * The rule now: credit goes to the OWNER who held the lead when it closed, and
 * never moves with a later reassignment.
 *
 * Owner at close = the to_owner_id of the latest ownership hop (E-295) at or
 * before closed_at; with no recorded hop, the lead's current owner (an owner
 * who never changed hands). Only Converted / Lost rows whose closing owner
 * differs from that are touched. Dry run by default; re-run = no-op.
 */
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";

type Row = { id: string; lead_status: string; closing_owner_id: string | null; owner_at_close: string | null };

async function main() {
    const apply = process.argv.includes("--apply");
    const rows = (await db.execute<Row>(sql`
        SELECT dl.id, dl.lead_status, dl.closing_owner_id,
               COALESCE(
                   (SELECT t.to_owner_id FROM lead_touchpoints t
                     WHERE t.dealer_lead_id = dl.id
                       AND t.to_owner_id IS NOT NULL
                       AND t.performed_at <= dl.closed_at
                     ORDER BY t.performed_at DESC LIMIT 1),
                   CASE WHEN NOT EXISTS (SELECT 1 FROM lead_touchpoints t2
                                          WHERE t2.dealer_lead_id = dl.id AND t2.to_owner_id IS NOT NULL)
                        THEN dl.current_owner_id END
               ) AS owner_at_close
          FROM dealer_leads dl
         WHERE dl.lead_status IN ('Converted', 'Lost')
           AND dl.closed_at IS NOT NULL
    `)) as unknown as Row[];

    const fix = rows.filter((r) => r.owner_at_close && r.owner_at_close !== r.closing_owner_id);
    console.log(`${rows.length} closed leads; ${fix.length} credited to someone other than the owner at close`);
    for (const r of fix.slice(0, 20)) {
        console.log(`  ${r.id} ${r.lead_status}: ${r.closing_owner_id ?? "(none)"} → ${r.owner_at_close}`);
    }
    if (!apply) {
        console.log("Dry run. Re-run with --apply to write.");
        process.exit(0);
    }
    for (const r of fix) {
        await db.execute(sql`
            UPDATE dealer_leads SET closing_owner_id = ${r.owner_at_close}
             WHERE id = ${r.id} AND closing_owner_id IS DISTINCT FROM ${r.owner_at_close}
        `);
    }
    console.log(`Updated ${fix.length}.`);
    process.exit(0);
}

void main();
