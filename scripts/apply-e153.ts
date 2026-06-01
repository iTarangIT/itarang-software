import { readFileSync } from "node:fs";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const sql = postgres(url, { ssl: { rejectUnauthorized: false } });

async function main() {
  const migration = readFileSync("drizzle/E-153_vkyc_mode_allow_passive.sql", "utf8");
  console.log("Applying E-153_vkyc_mode_allow_passive.sql ...");
  await sql.unsafe(migration);
  const [con] = await sql`
    SELECT pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'video_kyc_verifications'
      AND con.conname = 'video_kyc_verifications_mode_check'`;
  console.log("mode constraint now:", con?.def ?? "(missing!)");
  await sql.end();
}
main().catch(async (e) => { console.error(e); await sql.end(); process.exit(1); });
