import { readFileSync } from "node:fs";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = postgres(url, { ssl: { rejectUnauthorized: false } });

async function main() {
  const migration = readFileSync("drizzle/E-152_vkyc_passive_link.sql", "utf8");
  console.log("Applying E-152_vkyc_passive_link.sql ...");
  await sql.unsafe(migration);
  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'video_kyc_verifications'
      AND column_name IN ('link_channel','link_sent_at','link_expires_at')
    ORDER BY column_name`;
  console.log("Present columns:", cols.map((c) => c.column_name));
  await sql.end();
}

main().catch(async (e) => {
  console.error(e);
  await sql.end();
  process.exit(1);
});
