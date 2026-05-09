import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set after loading .env.local");

  const host = url.match(/@([^/?]+)/)?.[1] ?? "unknown";
  console.log("Connecting to:", host);

  const sql = postgres(url, { max: 1, ssl: "require", prepare: false });

  const total = await sql`SELECT count(*)::int AS c FROM dealer_leads`;
  const withPhone = await sql`SELECT count(*)::int AS c FROM dealer_leads WHERE phone IS NOT NULL AND phone <> ''`;
  const sample = await sql`SELECT id, dealer_name, phone, current_status, provider FROM dealer_leads LIMIT 3`;

  console.log("=== dealer_leads diagnostic ===");
  console.log("Total rows:        ", total[0].c);
  console.log("Rows with phone:   ", withPhone[0].c);
  console.log("Sample (first 3):  ", JSON.stringify(sample, null, 2));

  await sql.end();
}

main().catch((e) => {
  console.error("DIAG FAILED:", e.message);
  process.exit(1);
});
