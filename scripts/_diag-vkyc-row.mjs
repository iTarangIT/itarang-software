import { readFileSync } from "node:fs";
import postgres from "postgres";
const env = readFileSync(".env.local","utf8");
const url = env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g,"");
const sql = postgres(url,{ssl:"require",prepare:false,max:1,connect_timeout:15});
try{
  const rows = await sql`
    SELECT id, mode, status, match_score, liveliness, static_risk, prerecorded_risk,
           provider_name, provider_raw_status, failure_reason, session_video_url,
           provider_raw_payload, updated_at
    FROM video_kyc_verifications
    WHERE lead_id = 'LEAD-20260601-0345e564'
    ORDER BY updated_at DESC`;
  for (const r of rows) {
    console.log("── row", r.id, "─────────────");
    console.log("mode:", r.mode, "| status:", r.status, "| provider_raw_status:", r.provider_raw_status);
    console.log("match_score:", r.match_score, "| liveliness:", r.liveliness, "| static_risk:", r.static_risk, "| prerecorded_risk:", r.prerecorded_risk);
    console.log("session_video_url:", r.session_video_url);
    console.log("failure_reason:", r.failure_reason);
    console.log("provider_raw_payload:", JSON.stringify(r.provider_raw_payload, null, 2));
    console.log("updated_at:", r.updated_at);
  }
  if (!rows.length) console.log("No vkyc row for this lead.");
} finally { await sql.end(); }
