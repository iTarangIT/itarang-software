#!/usr/bin/env node
// Deeper dive: who are the 38 rows in DB that don't match the API list?

import fs from "node:fs";
import path from "node:path";
import { config } from "dotenv";
config({ path: ".env.local" });

const postgres = (await import("postgres")).default;
const sql = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, max: 1 });

const groundTruth = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "scripts", "out", "elevenlabs-30d.json"), "utf8"),
);
const apiIds = new Set(groundTruth.map((r) => r.conversation_id));

// Pull ALL ElevenLabs rows + their agent_id (if captured)
const rows = await sql`
  SELECT
    acl.call_id,
    acl.agent_id,
    acl.ended_at,
    acl.call_duration,
    acl.total_cost_cents,
    acl.cost_fetched_at,
    acl.status,
    acl.created_at
  FROM ai_call_logs acl
  WHERE acl.provider = 'elevenlabs'
    AND acl.ended_at >= '2026-04-19'::date
    AND acl.ended_at <  '2026-05-20'::date
  ORDER BY acl.ended_at ASC
`;

console.log(`DB rows total: ${rows.length}`);
console.log(`First 5 call_ids: ${rows.slice(0, 5).map(r => r.call_id).join(", ")}`);

// Categorize
const matching = rows.filter((r) => apiIds.has(r.call_id));
const notMatching = rows.filter((r) => !apiIds.has(r.call_id));
console.log(`\nRows where call_id matches API: ${matching.length}`);
console.log(`Rows where call_id does NOT match API: ${notMatching.length}`);

console.log("\n--- Sample of NON-MATCHING DB call_ids (first 10) ---");
for (const r of notMatching.slice(0, 10)) {
  console.log(`  call_id=${r.call_id}`);
  console.log(`    agent_id=${r.agent_id} ended_at=${r.ended_at?.toISOString?.()} status=${r.status} cost=${r.total_cost_cents}¢ duration=${r.call_duration}`);
}

// What agents are present?
const agentDist = await sql`
  SELECT agent_id, COUNT(*)::int AS n, SUM(total_cost_cents)::int AS sum_cents,
         COUNT(CASE WHEN call_duration > 0 THEN 1 END)::int AS with_duration
  FROM ai_call_logs
  WHERE provider = 'elevenlabs'
    AND ended_at >= '2026-04-19'::date
    AND ended_at <  '2026-05-20'::date
  GROUP BY agent_id
  ORDER BY n DESC
`;
console.log("\n--- AGENT_ID DISTRIBUTION ---");
console.log(agentDist);

// Check if non-matching IDs are conv_* or something else
const formats = {};
for (const r of notMatching) {
  const prefix = r.call_id?.slice(0, 6);
  formats[prefix] = (formats[prefix] || 0) + 1;
}
console.log("\n--- NON-MATCHING ID PREFIXES ---");
console.log(formats);

// Probe whether non-matching IDs are valid conversation_ids by hitting DETAIL directly
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
console.log("\n--- PROBE API for 5 non-matching IDs ---");
for (const r of notMatching.slice(0, 5)) {
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(r.call_id)}`,
      { headers: { "xi-api-key": ELEVENLABS_KEY } },
    );
    if (res.ok) {
      const d = await res.json();
      const meta = d.metadata || {};
      console.log(`  ${r.call_id}: 200 OK | agent=${d.agent_id} | cost=${meta.cost}cr dur=${meta.call_duration_secs}s start=${meta.start_time_unix_secs ? new Date(meta.start_time_unix_secs * 1000).toISOString() : "n/a"}`);
    } else {
      console.log(`  ${r.call_id}: ${res.status}`);
    }
  } catch (e) {
    console.log(`  ${r.call_id}: ERR ${e.message}`);
  }
}

// Look at the 16 unpriced rows from API too — were they ever inserted?
const unpricedApi = groundTruth.filter((r) => r.cost_credits === 0);
console.log(`\n--- UNPRICED API conversations: ${unpricedApi.length} ---`);
for (const r of unpricedApi.slice(0, 5)) {
  const inDb = rows.find((db) => db.call_id === r.conversation_id);
  console.log(`  ${r.conversation_id}: dur=${r.duration_secs}s | in DB? ${!!inDb}`);
}

await sql.end();
