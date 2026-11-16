// ID 252 — before release: how many leads does a Sales Head own today? Read-only.
//
//   node --import tsx --env-file=.env.local scripts/verify-id252-sales-head-owned-leads.ts
//
// Until ID 252 every lead action refused the Sales Head, so a lead Admin gave him
// froze while its time limits kept running. Prints, per active Sales Head, the
// leads he owns by status, and the oldest last-update among them. Writes nothing.

import { sql } from "drizzle-orm";

async function main() {
  const { db } = await import("@/lib/db");
  const rows = (await db.execute(sql`
    SELECT u.name, u.email, coalesce(l.current_status, l.lead_status)::text AS status, count(*)::int AS n,
           min(l.updated_at) AS oldest_update
      FROM dealer_leads l
      JOIN users u ON u.id::text = l.current_owner_id
     WHERE u.role = 'sales_head'
     GROUP BY u.name, u.email, 3
     ORDER BY u.name, n DESC
  `)) as unknown as Array<{ name: string | null; email: string | null; status: string | null; n: number; oldest_update: Date | null }>;

  if (!rows.length) {
    console.log("No lead is owned by a Sales Head login today.");
    process.exit(0);
  }
  let total = 0;
  let who = "";
  for (const r of rows) {
    const label = `${r.name ?? "(no name)"} <${r.email ?? "?"}>`;
    if (label !== who) console.log(`\n${(who = label)}`);
    const oldest = r.oldest_update ? new Date(r.oldest_update).toISOString().slice(0, 10) : "-";
    console.log(`  ${String(r.n).padStart(5)}  ${r.status ?? "(no status)"}  (oldest update ${oldest})`);
    total += r.n;
  }
  console.log(`\nTotal leads owned by a Sales Head: ${total}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
