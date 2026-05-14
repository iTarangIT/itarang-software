// Quick state check — what's actually in dealer_leads via the Drizzle
// connection right now? Compares against the user's pgAdmin observation
// of 1 row. NOT committed.

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

async function main() {
  const { sql } = await import("drizzle-orm");
  const { db } = await import("../src/lib/db");

  console.log(`[check] DATABASE_URL host: ${new URL(process.env.DATABASE_URL!).hostname}`);

  const count = await db.execute(sql`SELECT COUNT(*)::int AS n FROM dealer_leads`);
  console.log("[check] dealer_leads total rows:", count);

  const recent = await db.execute(sql`
    SELECT id, dealer_name, phone, location, current_status, created_at
    FROM dealer_leads
    ORDER BY created_at DESC NULLS LAST
    LIMIT 20
  `);
  console.log("[check] dealer_leads recent 20 rows:");
  console.table(recent);

  const targetPhone = await db.execute(sql`
    SELECT id, dealer_name, phone, created_at
    FROM dealer_leads
    WHERE phone = '9606235461' OR phone = '+919606235461' OR phone LIKE '%9606235461%'
  `);
  console.log("[check] rows matching 9606235461 (any form):");
  console.table(targetPhone);

  setTimeout(() => process.exit(0), 200);
}

main().catch((err) => {
  console.error("[check] failed:", err);
  process.exit(1);
});
