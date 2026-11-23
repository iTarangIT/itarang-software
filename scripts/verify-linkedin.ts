// Read-only check of the LinkedIn Outreach data (E-393). Imports the module's
// own query helpers rather than restating them.
//
//   node --import tsx --env-file=.env.local scripts/verify-linkedin.ts
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { credentialStatus } from "@/lib/linkedin/credentials";
import { accountsOverview } from "@/lib/linkedin/services/accounts";

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
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
