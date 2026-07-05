import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const url = env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, "");
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
try {
  console.log("HOST:", new URL(url).hostname);
  const rows = await sql`
    SELECT wa_phone, current_state, application_id, context, updated_at
    FROM whatsapp_onboarding_sessions
    WHERE wa_phone LIKE ${'%8208677782%'}
    ORDER BY updated_at DESC`;
  console.log("Sessions matched:", rows.length);
  for (const r of rows) {
    const ctx = r.context ?? {};
    console.log("\n---");
    console.log("wa_phone      :", r.wa_phone);
    console.log("current_state :", r.current_state);
    console.log("context.flow  :", ctx.flow ?? "(undefined)");
    console.log("context.lead  :", JSON.stringify(ctx.lead ?? null));
    console.log("updated_at    :", r.updated_at);
  }
} finally { await sql.end(); }
