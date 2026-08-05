// Applies drizzle/E-225_neodove_campaign_mirror.sql to whatever DATABASE_URL
// points at in .env.local. Idempotent — safe to re-run. Run with:
//   node scripts/apply-e225.mjs
//
// Without this, creating or editing a NeoDove campaign 500s with
// `column "mirror_config" of relation "neodove_campaigns" does not exist`:
// the INSERT names the column unconditionally once the modal sends a mirror.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const url = env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, "");
const ddl = readFileSync("drizzle/E-225_neodove_campaign_mirror.sql", "utf8");

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
try {
  console.log("HOST:", new URL(url).hostname);
  await sql.unsafe(ddl);

  const cols = await sql`
    SELECT data_type FROM information_schema.columns
    WHERE table_name = 'neodove_campaigns' AND column_name = 'mirror_config'`;

  const ok = cols.length === 1 && cols[0].data_type === "jsonb";
  console.log(
    ok
      ? "OK — E-225 applied. neodove_campaigns.mirror_config is jsonb; New campaign / Campaign settings can now save."
      : `FAILED — expected one jsonb mirror_config column, got ${JSON.stringify(cols)}.`,
  );
} finally {
  await sql.end();
}
