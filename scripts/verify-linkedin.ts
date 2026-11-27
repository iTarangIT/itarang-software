// Read-only check of the LinkedIn Outreach data (E-393). Imports the module's
// own query helpers rather than restating them.
//
//   node --import tsx --env-file=.env.local scripts/verify-linkedin.ts
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { credentialStatus } from "@/lib/linkedin/credentials";
import { accountsOverview } from "@/lib/linkedin/services/accounts";
import { analytics } from "@/lib/linkedin/services/analytics";
import { campaignRowsTable } from "@/lib/linkedin/services/export";
import { extrasReady } from "@/lib/linkedin/services/extras";

async function main() {
  const tables = await db.execute(sql`
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'li\\_%' ORDER BY 1`);
  const names = (tables as unknown as { name: string }[]).map((t) => t.name);
  console.log(`li_* tables: ${names.length}`, names.join(", "));
  if (names.length < 14) {
    console.log("E-393 is not (fully) applied on this database.");
    process.exit(1);
  }

  const dupes = await db.execute(sql`
    SELECT 'profile_id' AS k, count(*) - count(DISTINCT profile_id) AS n FROM li_prospects
    UNION ALL SELECT 'public_url', count(*) - count(DISTINCT public_url) FROM li_prospects
    UNION ALL SELECT 'live campaigns per prospect', count(*) FROM (
      SELECT prospect_id FROM li_campaign_prospects
      WHERE state IN ('approved','queued','invite_sent','accepted','message_sent','seen')
      GROUP BY prospect_id HAVING count(*) > 1) x`);
  console.log("duplicates (all must be 0):", dupes);

  const creds = await credentialStatus();
  console.log("encryption key on this server:", creds.encryption);
  for (const c of creds.items) console.log(`  ${c.slot.padEnd(22)} ${c.source}${c.last4 ? ` ••••${c.last4}` : ""}`);

  for (const a of await accountsOverview()) {
    console.log(
      `account ${a.label} [${a.status}] invites ${a.today.invites}/${a.today.invite_cap}, messages ${a.today.messages}/${a.today.message_cap}`,
    );
  }
  await checkAnalytics();
  process.exit(process.exitCode ?? 0);
}

/** E-398: the Analytics funnel and the export agree with a direct count. */
async function checkAnalytics() {
  console.log("E-398 (categories + meetings) applied:", await extrasReady());
  const a = await analytics({});
  console.log("by category:");
  for (const c of [...a.categories, a.total]) {
    console.log(
      `  ${c.category.padEnd(16)} campaigns ${c.campaigns}  approached ${c.approached}  accepted ${c.accepted}  replied ${c.replied}  meetings ${c.meetings}`,
    );
  }
  const [direct] = (await db.execute(sql`
    SELECT count(*)::int AS rows,
      count(*) FILTER (WHERE invite_sent_at IS NOT NULL OR message_sent_at IS NOT NULL)::int AS approached,
      count(*) FILTER (WHERE invite_sent_at IS NOT NULL AND accepted_at IS NOT NULL)::int AS accepted,
      count(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied
    FROM li_campaign_prospects`)) as unknown as { rows: number; approached: number; accepted: number; replied: number }[];
  const ok =
    a.total.selected === Number(direct.rows) &&
    a.total.approached === Number(direct.approached) &&
    a.total.accepted === Number(direct.accepted) &&
    a.total.replied === Number(direct.replied);
  console.log(`analytics total vs direct count: ${ok ? "MATCH" : "MISMATCH"}`, direct);
  const exported = await campaignRowsTable({});
  const exportOk = exported.rows.length === Math.min(Number(direct.rows), 10_000);
  console.log(`export campaign rows ${exported.rows.length} vs ${direct.rows}: ${exportOk ? "MATCH" : "MISMATCH"}`);
  if (!ok || !exportOk) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
