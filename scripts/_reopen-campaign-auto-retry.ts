// One-off (E-315): switch automatic retries ON for a campaign that finished
// before E-315 shipped, and book its unreached leads for an immediate redial.
//
//   node --import tsx --env-file=.env.production scripts/_reopen-campaign-auto-retry.ts <campaignId>          # dry run
//   node --import tsx --env-file=.env.production scripts/_reopen-campaign-auto-retry.ts <campaignId> --apply  # write
//
// Which rows: exactly those retryPolicy.isAutoRetryable() accepts (the same
// rule the live writer uses), with dials left under 1 + max_retries. A row
// dialled before E-315 carries attempt_count 0 — it WAS dialled once, so it is
// set to 1 here and keeps the same 4-dial budget as a new campaign.
//
// The campaign goes back to 'running' with completed_at cleared; the 60s
// window tick (wakeDueRetries) then dials the booked rows one at a time.
// Leads the AI has since spoken to are skipped at dial time by advanceCampaign.

import postgres from "postgres";
import { isAutoRetryable } from "@/lib/ai-dialer/retryPolicy";

const MAX_RETRIES = 3;
const [campaignId, flag] = process.argv.slice(2);
const apply = flag === "--apply";
if (!campaignId) {
  console.error("usage: _reopen-campaign-auto-retry.ts <campaignId> [--apply]");
  process.exit(1);
}

(async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, ssl: "require" });
  console.log("target:", new URL(process.env.DATABASE_URL!).host.split(".")[0], "·", campaignId, apply ? "· APPLY" : "· dry run");

  const [c] = await sql`select id, name, status, max_retries from dialer_campaigns where id = ${campaignId}`;
  if (!c) throw new Error("campaign not found");
  if (c.status === "running") throw new Error("campaign is already running — nothing to reopen");
  console.log(c);

  const rows = await sql<{ id: string; status: string; call_outcome: string | null; attempt_count: number }[]>`
    select id, status, call_outcome, attempt_count from dialer_campaign_leads where campaign_id = ${campaignId}`;
  const pick = rows.filter(
    (r) => isAutoRetryable(r.status, r.call_outcome) && Math.max(r.attempt_count, 1) < 1 + MAX_RETRIES,
  );
  const byStatus: Record<string, number> = {};
  for (const r of pick) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  console.log(`rows: ${rows.length} · to redial: ${pick.length}`, byStatus);

  if (!apply || pick.length === 0) {
    await sql.end();
    return;
  }

  await sql.begin(async (txRaw) => {
    // postgres.js types TransactionSql without the tagged-template call signature.
    const tx = txRaw as unknown as typeof sql;
    const ids = pick.map((r) => r.id);
    await tx`
      update dialer_campaign_leads
         set attempt_count = greatest(attempt_count, 1),
             next_attempt_at = now()
       where id = any(${ids}) and campaign_id = ${campaignId}`;
    await tx`
      update dialer_campaigns
         set max_retries = ${MAX_RETRIES},
             status = 'running',
             completed_at = null,
             last_advanced_at = now()
       where id = ${campaignId}`;
  });

  const [after] = await sql`
    select c.status, c.max_retries,
           (select count(*)::int from dialer_campaign_leads l where l.campaign_id = c.id and l.next_attempt_at is not null) as booked
      from dialer_campaigns c where c.id = ${campaignId}`;
  console.log("after:", after);
  await sql.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
