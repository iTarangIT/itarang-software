// Applies E-154 (video_kyc_verifications.session_video_url) against DATABASE_URL.
// Additive + idempotent — safe to re-run.
//
// Run via:  ! node scripts/_apply-e154.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const m = env.match(/^DATABASE_URL=(.*)$/m);
if (!m) { console.error("DATABASE_URL not found"); process.exit(1); }
const url = m[1].trim().replace(/^["']|["']$/g, "");

const migration = readFileSync("drizzle/E-154_vkyc_session_video_url.sql", "utf8");

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
try {
  console.log("HOST:", new URL(url).hostname);
  await sql.unsafe(migration);
  const r = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'video_kyc_verifications' AND column_name = 'session_video_url'`;
  console.log(r[0] ? "E-154 applied. video_kyc_verifications.session_video_url present." : "E-154 ran but column not found (unexpected)");
} finally {
  await sql.end();
}
