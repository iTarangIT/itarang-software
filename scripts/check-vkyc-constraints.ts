import postgres from "postgres";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const sql = postgres(url, { ssl: { rejectUnauthorized: false } });

async function main() {
  const cons = await sql`
    SELECT con.conname, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'video_kyc_verifications'
    ORDER BY con.contype`;
  console.log("=== Constraints on video_kyc_verifications ===");
  for (const c of cons) console.log(`${c.conname}: ${c.def}`);

  // varchar length limits
  const lens = await sql`
    SELECT column_name, character_maximum_length
    FROM information_schema.columns
    WHERE table_name='video_kyc_verifications' AND data_type='character varying'
    ORDER BY ordinal_position`;
  console.log("\n=== varchar max lengths ===");
  for (const l of lens) console.log(`${l.column_name}: ${l.character_maximum_length}`);
  await sql.end();
}
main().catch(async (e) => { console.error(e); await sql.end(); process.exit(1); });
