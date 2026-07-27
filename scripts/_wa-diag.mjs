import { readFileSync } from "node:fs";
import postgres from "postgres";
const clean = (v) => v.trim().replace(/^["']|["']$/g, "");
const env = readFileSync(".env.local", "utf8");
const url = [...env.matchAll(/^\s*DATABASE_URL\s*=\s*(.+)$/gm)]
  .map((m) => clean(m[1])).find((u) => u.startsWith("postgres"));
console.log("host:", (url.match(/@([^:/]+)/) || [])[1], "\n");
const phone = process.argv[2] || "918208677782";
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
try {
  console.log("--- whatsapp_operators ---");
  console.table(await sql`SELECT wa_phone, display_name, is_active FROM whatsapp_operators`);
  console.log("--- sessions for", phone, "---");
  console.table(await sql`
    SELECT session_kind, current_state, session_status, application_id IS NOT NULL AS has_app,
           to_char(created_at,'MM-DD HH24:MI') AS created
    FROM whatsapp_onboarding_sessions WHERE wa_phone = ${phone}
    ORDER BY created_at`);
  console.log("--- last 8 messages on that phone's sessions ---");
  console.table(await sql`
    SELECT m.direction, m.delivery_status, left(coalesce(m.text_body,''),58) AS body,
           to_char(m.created_at,'MM-DD HH24:MI:SS') AS at
    FROM whatsapp_messages m
    LEFT JOIN whatsapp_onboarding_sessions s ON s.id = m.session_id
    WHERE s.wa_phone = ${phone} OR m.raw_payload::text LIKE ${'%' + phone + '%'}
    ORDER BY m.created_at DESC LIMIT 8`);
} finally { await sql.end(); }
