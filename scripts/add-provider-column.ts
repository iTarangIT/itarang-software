import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");

  const host = url.match(/@([^/?]+)/)?.[1] ?? "unknown";
  console.log("Connecting to:", host);

  const sql = postgres(url, { max: 1, ssl: "require", prepare: false });

  console.log("Running: ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'bolna'");
  await sql`ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'bolna'`;

  const cols = await sql`
    SELECT column_name, data_type, column_default
    FROM information_schema.columns
    WHERE table_name = 'dealer_leads' AND column_name = 'provider'
  `;
  console.log("provider column status:", cols);

  const sample = await sql`SELECT count(*)::int AS total, count(provider)::int AS with_provider FROM dealer_leads`;
  console.log("dealer_leads rows:", sample[0]);

  await sql.end();
  console.log("Done.");
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
