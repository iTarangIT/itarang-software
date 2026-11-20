// One-off (20 Nov 2026): re-open "Howrah part 1", closed 'completed' at 15:44 IST
// on 19 Nov by the legacy /api/ai-dialer/status timeout path while 22 automatic
// retries were booked (fixed in finalizeCampaign + the status route).
//
// Dry run (default) prints what would change; --apply writes.
//   node --import tsx --env-file=.env.production scripts/_reopen-howrah-part1.mts
//   node --import tsx --env-file=.env.production scripts/_reopen-howrah-part1.mts --apply
//
// Writes:
//   - dialer_campaigns: status 'running', completed_at / last_advanced_at NULL
//     (the 60 s window tick, wakeDueRetries, then redials booked rows).
//   - Unreached rows with NO redial booked (not switchboard, not a wrong
//     number): next_attempt_at = now() + 1 min, so the new 7-day rule applies.
//     Their long-horizon ai_redial_plan row, if any (e.g. "Need Some Time" on an
//     early hang-up), is marked used and made due now, or the dial-time check
//     would skip the lead as "redial not due".
// Never touched: completed rows, the switchboard row, wrong numbers.
import postgres from "postgres";

const CAMPAIGN_ID = "camp_mwn976x0_kowwedl1";
const apply = process.argv.includes("--apply");
const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, ssl: { rejectUnauthorized: false } });

const [c] = await sql`select id, name, status, completed_at from dialer_campaigns where id = ${CAMPAIGN_ID}`;
if (!c) throw new Error("campaign not found");
console.log(`${c.name} · ${c.status} · closed ${c.completed_at?.toISOString() ?? "-"}`);

const rows = await sql`
  select d.id, d.lead_id, d.status, d.call_outcome, d.next_attempt_at, l.shop_name,
         exists(select 1 from ai_redial_plan rp where rp.lead_id = d.lead_id and rp.due_at > now()) as long_plan
    from dialer_campaign_leads d join dealer_leads l on l.id = d.lead_id
   where d.campaign_id = ${CAMPAIGN_ID}
   order by d.queue_position`;
const booked = rows.filter((r) => r.next_attempt_at);
const toBook = rows.filter(
  (r) =>
    !r.next_attempt_at &&
    !["completed", "switchboard", "skipped", "pending", "calling"].includes(r.status) &&
    !/invalid_number|no_phone|ineligible/i.test(r.call_outcome ?? ""),
);
console.log(`${rows.length} rows · ${booked.length} already booked · ${toBook.length} to book now`);
for (const r of toBook) console.log(`  book · ${r.status}/${r.call_outcome} · ${r.shop_name}${r.long_plan ? " · clears long-horizon plan" : ""}`);

if (!apply) {
  console.log("dry run — pass --apply to write");
} else {
  await sql.begin(async (tx) => {
    for (const r of toBook) {
      await tx`update dialer_campaign_leads set next_attempt_at = now() + interval '1 minute' where id = ${r.id} and next_attempt_at is null`;
      await tx`update ai_redial_plan set used = true, due_at = now(), updated_at = now() where lead_id = ${r.lead_id} and due_at > now()`;
    }
    const u = await tx`
      update dialer_campaigns set status = 'running', completed_at = null, last_advanced_at = null
       where id = ${CAMPAIGN_ID} and status = 'completed' returning id`;
    console.log(`campaign re-opened: ${u.length === 1}`);
  });
}
await sql.end();
