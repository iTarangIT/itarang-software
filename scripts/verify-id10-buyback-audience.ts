// ID 10 — who receives Buyback Daily, worked out exactly as a send does. Read-only.
//
//   node --import tsx --env-file=.env.local scripts/verify-id10-buyback-audience.ts
//
// Prints the always-included audience (CEO + buyback SPOCs: request owners, people who called
// a buyback lead in 90 days, current owners of buyback leads), the addresses saved on the
// settings screen, and whether the digest is switched on. Sends nothing.

import { sql } from "drizzle-orm";

async function main() {
  const { db } = await import("@/lib/db");
  const { buybackDailyDigest } = await import("@/lib/digests/kinds/buyback-daily");
  const { getDigestSettings } = await import("@/lib/digests/settings");

  const audience = (await buybackDailyDigest.audience?.resolve()) ?? [];
  const settings = await getDigestSettings(buybackDailyDigest);
  console.log(`enabled: ${settings.enabled}  (off = nothing is sent; switch on in Settings › Buyback Daily)`);
  console.log(`saved recipients: ${settings.recipients.length ? settings.recipients.join(", ") : "(none)"}`);
  console.log(`always included (${audience.length}):`);

  const rows = audience.length
    ? ((await db.execute(sql`
        SELECT lower(email) AS email, role FROM users WHERE lower(email) IN ${audience.map((e) => e.toLowerCase())}
      `)) as unknown as Array<{ email: string; role: string }>)
    : [];
  const role = new Map(rows.map((r) => [r.email, r.role]));
  for (const email of audience) console.log(`  ${email}  (${role.get(email.toLowerCase()) ?? "?"})`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
