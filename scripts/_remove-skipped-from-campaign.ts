// One-off: take the leads that were SKIPPED (never dialled) out of one AI-dialer
// campaign, so every count on the campaign page agrees with the leads it dialled.
//
//   node --import tsx --env-file=.env.local scripts/_remove-skipped-from-campaign.ts <campaignId>          # dry run
//   node --import tsx --env-file=.env.local scripts/_remove-skipped-from-campaign.ts <campaignId> --apply
//
// Only rows with status 'skipped' are removed; every dialled row, its attempts
// and its call logs stay. The leads themselves stay in the CRM (a skipped "not a
// mobile" lead is still listed under Needs dealer mobile). Counters are
// re-derived afterwards with syncCampaignCounters, and total_leads is set to the
// rows left. Prints the database it runs against.
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { syncCampaignCounters } from "../src/lib/queue/campaignTracker";

const campaignId = process.argv[2];
const APPLY = process.argv.includes("--apply");
if (!campaignId || campaignId.startsWith("--")) throw new Error("usage: <campaignId> [--apply]");

const rowsOf = <T>(r: unknown) => r as T[];

async function main() {
    console.log(`target: ${new URL(process.env.DATABASE_URL!).host.split(".")[0]} — ${APPLY ? "APPLY" : "dry run"}`);
    const [c] = rowsOf<{ name: string; total_leads: number; calls_made: number }>(
        await db.execute(sql`SELECT name, total_leads, calls_made FROM dialer_campaigns WHERE id = ${campaignId}`),
    );
    if (!c) throw new Error(`campaign ${campaignId} not found`);
    const counts = rowsOf<{ status: string; n: number }>(
        await db.execute(sql`
            SELECT status, count(*)::int AS n FROM dialer_campaign_leads
             WHERE campaign_id = ${campaignId} GROUP BY 1 ORDER BY 2 DESC`),
    );
    const skipped = counts.find((r) => r.status === "skipped")?.n ?? 0;
    const all = counts.reduce((s, r) => s + r.n, 0);
    console.log(`"${c.name}": ${all} rows, ${skipped} skipped; total_leads ${c.total_leads}, calls_made ${c.calls_made}`);
    if (!APPLY || skipped === 0) return;

    await db.transaction(async (tx) => {
        const del = rowsOf<{ id: string }>(
            await tx.execute(sql`
                DELETE FROM dialer_campaign_leads
                 WHERE campaign_id = ${campaignId} AND status = 'skipped'
                RETURNING id`),
        );
        await tx.execute(sql`
            UPDATE dialer_campaigns
               SET total_leads = (SELECT count(*) FROM dialer_campaign_leads WHERE campaign_id = ${campaignId})
             WHERE id = ${campaignId}`);
        console.log(`removed ${del.length} skipped rows`);
    });
    await syncCampaignCounters(campaignId);
    const [after] = rowsOf<{ total_leads: number; calls_made: number; rows: number }>(
        await db.execute(sql`
            SELECT c.total_leads, c.calls_made,
                   (SELECT count(*)::int FROM dialer_campaign_leads WHERE campaign_id = c.id) AS rows
              FROM dialer_campaigns c WHERE c.id = ${campaignId}`),
    );
    console.log(`after: ${after.rows} rows, total_leads ${after.total_leads}, calls_made ${after.calls_made}`);
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
