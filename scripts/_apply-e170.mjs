// Apply E-170 (WhatsApp dealer self-service) to the connected host.
//
// The webhook fails at recordInbound with: column "dealer_session_id" of
// relation "whatsapp_messages" does not exist. schema.ts + E-170 both declare
// it, but E-170 never got applied here, so every inbound message 500s and the
// bot goes silent.
//
// E-170 is strictly additive + idempotent (CREATE TABLE/INDEX IF NOT EXISTS,
// ADD COLUMN IF NOT EXISTS), so re-running is a no-op. Run with:
//   node scripts/_apply-e170.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const m = env.match(/^DATABASE_URL=(.*)$/m);
if (!m) { console.error("DATABASE_URL not found"); process.exit(1); }
const url = m[1].trim().replace(/^["']|["']$/g, "");
const host = (url.match(/@([^:/]+)/) || [])[1];
console.log("Applying E-170 to host:", host);

const e170 = readFileSync("drizzle/E-170_whatsapp_dealer_sessions.sql", "utf8");

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
try {
  await sql.unsafe(e170);
  console.log("E-170 applied OK");

  const col = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'whatsapp_messages'
      AND column_name = 'dealer_session_id'`;
  const tbl = await sql`
    SELECT to_regclass('public.whatsapp_dealer_sessions') AS t`;
  console.log(
    "whatsapp_messages.dealer_session_id:",
    col.length ? "present" : "MISSING (unexpected)",
  );
  console.log(
    "whatsapp_dealer_sessions table:",
    tbl[0].t ? "present" : "MISSING (unexpected)",
  );
} finally {
  await sql.end();
}
