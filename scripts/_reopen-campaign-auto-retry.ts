// One-off (E-315): switch automatic retries ON for campaigns that finished
// before E-315 shipped, and book their unreached leads for a redial.
//
//   node --import tsx --env-file=.env.production scripts/_reopen-campaign-auto-retry.ts <campaignId> [<campaignId> …]          # dry run
//   node --import tsx --env-file=.env.production scripts/_reopen-campaign-auto-retry.ts <campaignId> [<campaignId> …] --apply  # write
//
// Which rows: those retryPolicy.isAutoRetryable() accepts (the same rule the
// live writer uses), with dials left under 1 + max_retries. A row dialled
// before E-315 carries attempt_count 0 — it WAS dialled once, so it is set to 1
// and keeps the same 4-dial budget as a new campaign.
//
// ONE BOOKING PER LEAD. Campaigns overlap (the same list re-run on another
// provider, a city inside a multi-city run), so a lead is booked only in the
// most recently started of the given campaigns, and not at all when:
//   - any campaign row for it is 'completed' (the dealer already spoke), or
//   - it is already queued / calling / booked in a RUNNING campaign.
//
// Campaigns on a provider other than elevenlabs are refused unless
// --allow-provider=<name> is passed: the Bolna run of 24 Sept failed 50/50 on
// its from_number config, and redialling it would fail the same way.
//
// Each campaign with at least one booking goes back to 'running' (completed_at
// cleared); the 60s window tick (wakeDueRetries) then dials them.

import postgres from "postgres";
import { isAutoRetryable } from "@/lib/ai-dialer/retryPolicy";

const MAX_RETRIES = 3;
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const allowProvider = args.find((a) => a.startsWith("--allow-provider="))?.split("=")[1];
const campaignIds = args.filter((a) => !a.startsWith("--"));
if (campaignIds.length === 0) {
  console.error("usage: _reopen-campaign-auto-retry.ts <campaignId> [<campaignId> …] [--apply]");
  process.exit(1);
}

type Row = {
  id: string;
  campaign_id: string;
  lead_id: string;
  status: string;
  call_outcome: string | null;
  attempt_count: number;
};

(async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, ssl: "require" });
  console.log(
    "target:",
    new URL(process.env.DATABASE_URL!).host.split(".")[0],
    apply ? "· APPLY" : "· dry run",
  );

  const camps = await sql<{ id: string; name: string; status: string; provider: string; started_at: Date }[]>`
    select id, name, status, provider, started_at from dialer_campaigns where id = any(${campaignIds})`;
  const missing = campaignIds.filter((id) => !camps.some((c) => c.id === id));
  if (missing.length) throw new Error(`campaign(s) not found: ${missing.join(", ")}`);

  const refused = camps.filter(
    (c) =>
      c.status === "running" ||
      (c.provider.toLowerCase() !== "elevenlabs" && c.provider.toLowerCase() !== allowProvider),
  );
  for (const c of refused) {
    console.log(`SKIP campaign ${c.id} (${c.name}) — ${c.status === "running" ? "already running" : `provider ${c.provider}`}`);
  }
  const usable = camps.filter((c) => !refused.includes(c));
  // Most recent first: a lead goes to the newest campaign that has it.
  usable.sort((a, b) => +new Date(b.started_at) - +new Date(a.started_at));

  const rows = await sql<Row[]>`
    select id, campaign_id, lead_id, status, call_outcome, attempt_count
      from dialer_campaign_leads where campaign_id = any(${usable.map((c) => c.id)})`;
  const leadIds = [...new Set(rows.map((r) => r.lead_id))];

  const completedAnywhere = new Set(
    (await sql<{ lead_id: string }[]>`
      select distinct lead_id from dialer_campaign_leads
       where lead_id = any(${leadIds}) and status = 'completed'`).map((r) => r.lead_id),
  );
  const liveElsewhere = new Set(
    (await sql<{ lead_id: string }[]>`
      select distinct l.lead_id from dialer_campaign_leads l
        join dialer_campaigns c on c.id = l.campaign_id
       where l.lead_id = any(${leadIds}) and c.status = 'running'
         and (l.status in ('pending','calling') or l.next_attempt_at is not null)`).map((r) => r.lead_id),
  );

  const taken = new Set<string>();
  const picks: Row[] = [];
  const report: Record<string, { name: string; booked: number; byStatus: Record<string, number>; dupSkipped: number }> = {};
  let skippedCompleted = 0;
  let skippedLive = 0;
  for (const c of usable) {
    report[c.id] = { name: c.name, booked: 0, byStatus: {}, dupSkipped: 0 };
    const rep = report[c.id];
    for (const r of rows.filter((x) => x.campaign_id === c.id)) {
      if (!isAutoRetryable(r.status, r.call_outcome)) continue;
      if (Math.max(r.attempt_count, 1) >= 1 + MAX_RETRIES) continue;
      if (completedAnywhere.has(r.lead_id)) { skippedCompleted++; continue; }
      if (liveElsewhere.has(r.lead_id)) { skippedLive++; continue; }
      if (taken.has(r.lead_id)) { rep.dupSkipped++; continue; }
      taken.add(r.lead_id);
      picks.push(r);
      rep.booked++;
      rep.byStatus[r.status] = (rep.byStatus[r.status] ?? 0) + 1;
    }
  }

  for (const [id, r] of Object.entries(report)) {
    console.log(`${id}  ${r.name}\n   book ${r.booked}`, r.byStatus, r.dupSkipped ? `· ${r.dupSkipped} already booked in a newer campaign` : "");
  }
  console.log(
    `TOTAL leads to redial: ${picks.length} · skipped: ${skippedCompleted} already completed elsewhere, ${skippedLive} live in a running campaign`,
  );

  if (!apply || picks.length === 0) {
    await sql.end();
    return;
  }

  const reopen = [...new Set(picks.map((p) => p.campaign_id))];
  await sql.begin(async (txRaw) => {
    // postgres.js types TransactionSql without the tagged-template call signature.
    const tx = txRaw as unknown as typeof sql;
    await tx`
      update dialer_campaign_leads
         set attempt_count = greatest(attempt_count, 1),
             next_attempt_at = now()
       where id = any(${picks.map((p) => p.id)})`;
    await tx`
      update dialer_campaigns
         set max_retries = ${MAX_RETRIES},
             status = 'running',
             completed_at = null,
             last_advanced_at = now()
       where id = any(${reopen})`;
  });

  const after = await sql`
    select c.id, c.status, c.max_retries,
           (select count(*)::int from dialer_campaign_leads l where l.campaign_id = c.id and l.next_attempt_at is not null) as booked
      from dialer_campaigns c where c.id = any(${reopen})`;
  console.table(after);
  await sql.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
