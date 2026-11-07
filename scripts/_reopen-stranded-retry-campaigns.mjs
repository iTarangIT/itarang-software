// One-off: reopen AI-dialer campaigns that were finalized 'completed' while
// automatic retries were still booked (next_attempt_at set). The legacy
// /api/ai-dialer/status timeout path closed them without checking; since a
// 'completed' campaign is never woken, the booked retries were never dialled.
// campaignTracker.finalizeCampaign now refuses that write.
//
//   node --env-file=.env.production scripts/_reopen-stranded-retry-campaigns.mjs            # dry run: list
//   node --env-file=.env.production scripts/_reopen-stranded-retry-campaigns.mjs --apply    # reopen all listed
//   node --env-file=.env.production scripts/_reopen-stranded-retry-campaigns.mjs --apply <campaignId> …  # only these
//
// --apply sets status='running' and clears completed_at. The 60s window tick
// (wakeDueRetries) then redials the booked rows one at a time, inside the
// calling window — overdue bookings go first.
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, ssl: "require" });
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const only = args.filter((a) => !a.startsWith("--"));

const stranded = await sql`
  select c.id, c.name, c.provider, c.completed_at,
         count(*) filter (where l.next_attempt_at is not null)::int as booked,
         min(l.next_attempt_at) as first_booked
    from dialer_campaigns c
    join dialer_campaign_leads l on l.campaign_id = c.id
   where c.status = 'completed'
   group by c.id
  having count(*) filter (where l.next_attempt_at is not null) > 0
   order by c.completed_at desc`;

const targets = only.length ? stranded.filter((c) => only.includes(c.id)) : stranded;
for (const c of stranded) {
  const mark = targets.includes(c) ? (apply ? "REOPEN" : "would reopen") : "skip";
  console.log(`${mark} · ${c.id} · ${c.name} · ${c.provider} · closed ${c.completed_at?.toISOString()} · ${c.booked} booked from ${c.first_booked?.toISOString()}`);
}
if (!stranded.length) console.log("no stranded campaigns");

if (apply && targets.length) {
  const ids = targets.map((c) => c.id);
  const r = await sql`
    update dialer_campaigns set status = 'running', completed_at = null
     where id = any(${ids}) and status = 'completed'
    returning id`;
  console.log(`reopened ${r.length} campaign(s)`);
}
await sql.end();
