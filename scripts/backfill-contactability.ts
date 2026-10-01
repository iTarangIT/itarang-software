/**
 * Backfill dealer_leads.contactability = 'non_responsive' (tracker ID 36).
 *
 *   node --import tsx --env-file=.env.local scripts/backfill-contactability.ts          # dry run
 *   node --import tsx --env-file=.env.local scripts/backfill-contactability.ts --apply  # write
 *
 * The flag is set live by reviewLeadContactability() after every call, but
 * only from E-314 onwards — a lead that crossed the non-responsive line before
 * (6 calls on 6 different IST days within 45 days, none connected; the SAME
 * nonResponsiveSql every report runs) has no flag and still sits in the working
 * queues and the idle counts. This sets it once for those leads.
 *
 * Only where contactability IS NULL (never overwrites a dead_number or a flag
 * already set), only active leads. One "Contactability" touchpoint per flagged
 * lead, as the live path writes. dead_number is NOT backfilled: it needs the
 * call outcome, which the live path reads from each new call.
 * Re-run = no-op (the UPDATE re-checks contactability IS NULL).
 *
 * AUDIT. The writes run with app.actor_id = ACTOR (withLeadActor), so the E-304
 * field-change trigger records this script as the author.
 */
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { nonResponsiveSql } from "../src/lib/leads/nonResponsive";
import { CONTACTABILITY_LABEL } from "../src/lib/leads/contactability";
import { writeTouchpoint } from "../src/lib/touchpoints/write";
import { withLeadActor } from "../src/lib/leads/actorContext";

const ACTOR = "system:backfill-contactability";
const REASON = "no answer on 6 different days within 45 days";

type Row = {
    id: string;
    lead_status: string | null;
    current_owner_id: string | null;
    owner_name: string | null;
    owner_role: string | null;
};

async function main() {
    const apply = process.argv.includes("--apply");
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
    console.log(`DB host: ${host}`);

    const [col] = (await db.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n FROM information_schema.columns
         WHERE table_name = 'dealer_leads' AND column_name = 'contactability'
    `)) as unknown as Array<{ n: number }>;
    if (!col?.n) {
        console.log("dealer_leads.contactability does not exist here (E-314 not applied). Nothing to do.");
        process.exit(0);
    }

    const [already] = (await db.execute<{ dead: number; nr: number }>(sql`
        SELECT COUNT(*) FILTER (WHERE contactability = 'dead_number')::int    AS dead,
               COUNT(*) FILTER (WHERE contactability = 'non_responsive')::int AS nr
          FROM dealer_leads WHERE is_active IS NOT FALSE
    `)) as unknown as Array<{ dead: number; nr: number }>;

    const rows = (await db.execute<Row>(sql`
        SELECT dl.id, dl.lead_status, dl.current_owner_id, u.name AS owner_name, u.role AS owner_role
          FROM dealer_leads dl
          LEFT JOIN users u ON u.id::text = dl.current_owner_id
         WHERE dl.contactability IS NULL
           AND dl.is_active IS NOT FALSE
           AND ${nonResponsiveSql(sql`dl.id`)}
         ORDER BY dl.id
    `)) as unknown as Row[];

    const tally = (key: (r: Row) => string) => {
        const m = new Map<string, number>();
        for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
        return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };

    console.log(`Already flagged (active): dead_number ${already?.dead ?? 0}, non_responsive ${already?.nr ?? 0}.`);
    console.log(`${rows.length} active, unflagged leads meet the non-responsive rule → would be set to non_responsive.`);
    console.log("  by lead_status:");
    for (const [k, n] of tally((r) => r.lead_status ?? "(no status)")) console.log(`    ${k}: ${n}`);
    console.log("  by owner role:");
    for (const [k, n] of tally((r) => (r.current_owner_id ? r.owner_role ?? "(unknown user)" : "(unowned)"))) {
        console.log(`    ${k}: ${n}`);
    }

    if (!apply) {
        console.log("Dry run. Re-run with --apply to write.");
        process.exit(0);
    }

    let updated = 0;
    await withLeadActor(ACTOR, async (tx) => {
        for (const r of rows) {
            const done = (await tx.execute(sql`
                UPDATE dealer_leads
                   SET contactability = 'non_responsive', contactability_at = NOW(), contactability_reason = ${REASON}
                 WHERE id = ${r.id} AND contactability IS NULL
                RETURNING id
            `)) as unknown as unknown[];
            if (!done.length) continue;
            const owner = r.current_owner_id ? r.owner_name?.trim() || r.current_owner_id : "no owner";
            await writeTouchpoint(
                {
                    dealerLeadId: r.id,
                    touchpointType: "contactability_flag",
                    performedBy: null,
                    remarks: `${CONTACTABILITY_LABEL.non_responsive} — ${REASON}. Moved to Number Repair; the owner is kept (${owner}). (Backfill)`,
                    syncMethod: "system",
                },
                { tx },
            );
            updated++;
        }
    });
    console.log(`Flagged ${updated} lead(s) non_responsive, one touchpoint each (audit: changed_by = '${ACTOR}').`);
    process.exit(0);
}

void main();
