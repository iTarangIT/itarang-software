import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const m = env.match(/^DATABASE_URL=(.*)$/m);
if (!m) { console.error("DATABASE_URL not found"); process.exit(1); }
const url = m[1].trim().replace(/^["']|["']$/g, "");

const migration = readFileSync("drizzle/E-109_dialer_campaigns.sql", "utf8");

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
try {
  console.log("HOST:", new URL(url).hostname);
  await sql.unsafe(migration);
  const t = await sql`
    SELECT to_regclass('public.dialer_campaigns')      AS campaigns,
           to_regclass('public.dialer_campaign_leads') AS leads`;
  console.log("E-109 applied. dialer_campaigns:", t[0].campaigns ? "ok" : "MISSING",
              "| dialer_campaign_leads:", t[0].leads ? "ok" : "MISSING");
} finally {
  await sql.end();
}
