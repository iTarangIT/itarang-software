#!/usr/bin/env node
// Probe ai_call_logs and compare row-by-row against ground-truth elevenlabs-30d.json.
// Surfaces:
//   - rows in API but missing from DB
//   - rows in DB with stored cost ≠ ground-truth cost
//   - rows in DB with NULL/0 call_duration
//   - SUM of total_cost_cents / call_duration in the 30-day window

import fs from "node:fs";
import path from "node:path";
import { config } from "dotenv";
config({ path: ".env.local" });

const postgres = (await import("postgres")).default;
const sql = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, max: 1 });
const client = { query: async (q) => ({ rows: await sql.unsafe(q) }), end: async () => sql.end() };

const groundTruth = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "scripts", "out", "elevenlabs-30d.json"), "utf8"),
);
const apiIds = new Set(groundTruth.map((r) => r.conversation_id));

// 1. Aggregate query (mirrors buildSummarySql) for the dashboard window
const aggSql = `
  SELECT
    COUNT(*)::int                                          AS total_rows,
    COUNT(acl.total_cost_cents)::int                       AS rows_with_cost,
    COUNT(NULLIF(acl.call_duration, 0))::int               AS rows_with_duration,
    COALESCE(SUM(acl.total_cost_cents), 0)::bigint         AS sum_cost_cents,
    COALESCE(SUM(acl.call_duration), 0)::bigint            AS sum_duration_secs
  FROM dialer_campaign_leads dcl
  INNER JOIN ai_call_logs acl ON acl.call_id = dcl.bolna_call_id
  WHERE acl.call_id IS NOT NULL
    AND dcl.bolna_call_id IS NOT NULL
    AND acl.ended_at >= '2026-04-19'::date
    AND acl.ended_at <  '2026-05-20'::date
    AND acl.provider = 'elevenlabs'
`;
const agg = await client.query(aggSql);
console.log("=== DASHBOARD AGGREGATE (current SQL, 2026-04-19 → 2026-05-19, ElevenLabs) ===");
console.log(agg.rows[0]);

// 2. Same aggregate WITHOUT the dialer_campaign_leads join
const aggNoJoin = await client.query(`
  SELECT
    COUNT(*)::int                                          AS total_rows,
    COUNT(acl.total_cost_cents)::int                       AS rows_with_cost,
    COUNT(NULLIF(acl.call_duration, 0))::int               AS rows_with_duration,
    COALESCE(SUM(acl.total_cost_cents), 0)::bigint         AS sum_cost_cents,
    COALESCE(SUM(acl.call_duration), 0)::bigint            AS sum_duration_secs
  FROM ai_call_logs acl
  WHERE acl.call_id IS NOT NULL
    AND acl.provider = 'elevenlabs'
    AND acl.ended_at >= '2026-04-19'::date
    AND acl.ended_at <  '2026-05-20'::date
`);
console.log("\n=== AI_CALL_LOGS ONLY (no DCL join, same window) ===");
console.log(aggNoJoin.rows[0]);

// 3. Pull all rows in window from ai_call_logs and diff against API
const rowsSql = `
  SELECT acl.call_id, acl.call_duration, acl.total_cost_cents, acl.cost_fetched_at,
         acl.llm_cost_cents, acl.tts_cost_cents, acl.stt_cost_cents, acl.telephony_cost_cents,
         acl.platform_cost_cents, acl.ended_at, acl.started_at,
         (dcl.bolna_call_id IS NOT NULL) AS has_dcl
  FROM ai_call_logs acl
  LEFT JOIN dialer_campaign_leads dcl ON dcl.bolna_call_id = acl.call_id
  WHERE acl.provider = 'elevenlabs'
    AND acl.ended_at >= '2026-04-19'::date
    AND acl.ended_at <  '2026-05-20'::date
  ORDER BY acl.ended_at ASC
`;
const rows = (await client.query(rowsSql)).rows;
console.log(`\n=== ROW-LEVEL DIFF (${rows.length} DB rows vs ${groundTruth.length} API rows) ===`);

const dbIds = new Set(rows.map((r) => r.call_id));
const inApiNotDb = [...apiIds].filter((id) => !dbIds.has(id));
const inDbNotApi = [...dbIds].filter((id) => !apiIds.has(id));
console.log(`In API but NOT in DB: ${inApiNotDb.length}`);
console.log(`In DB but NOT in API: ${inDbNotApi.length}`);
console.log(`Rows in DB without DCL row: ${rows.filter((r) => !r.has_dcl).length}`);
console.log(`Rows in DB with NULL/0 duration: ${rows.filter((r) => !r.call_duration).length}`);
console.log(`Rows in DB with NULL cost: ${rows.filter((r) => r.total_cost_cents == null).length}`);

// 4. Cost discrepancy per-row (only for rows with cost stored)
console.log("\n=== PER-ROW COST DISCREPANCY (DB cents vs ground-truth credits·0.0001·100) ===");
let dbSum = 0;
let truthSum = 0;
const discrepancies = [];
for (const row of rows) {
  const truthRow = groundTruth.find((r) => r.conversation_id === row.call_id);
  if (!truthRow) continue;
  const truthCents = Math.round(truthRow.cost_credits * 0.0001 * 100);
  const dbCents = row.total_cost_cents ?? 0;
  dbSum += dbCents;
  truthSum += truthCents;
  if (Math.abs(dbCents - truthCents) > 1) {
    discrepancies.push({ id: row.call_id, dbCents, truthCents, credits: truthRow.cost_credits });
  }
}
console.log(`DB sum of total_cost_cents (window): ${dbSum} cents = $${(dbSum / 100).toFixed(2)} = ₹${((dbSum / 100) * 83).toFixed(2)}`);
console.log(`Ground-truth sum at 0.0001/credit:   ${truthSum} cents = $${(truthSum / 100).toFixed(2)} = ₹${((truthSum / 100) * 83).toFixed(2)}`);
console.log(`Rows with >1¢ discrepancy: ${discrepancies.length}`);
console.log("First 5 discrepancies:");
for (const d of discrepancies.slice(0, 5)) {
  console.log(`  ${d.id}: db=${d.dbCents}¢ truth=${d.truthCents}¢ credits=${d.credits} ratio=${(d.dbCents / d.truthCents).toFixed(3)}`);
}

// 5. Duration coverage detail
console.log("\n=== DURATION CHECK ===");
const rowsWithDurationInDb = rows.filter((r) => r.call_duration > 0);
const durationFromApi = groundTruth
  .filter((r) => dbIds.has(r.conversation_id))
  .reduce((s, r) => s + (r.duration_secs || 0), 0);
console.log(`DB rows w/ duration > 0: ${rowsWithDurationInDb.length}`);
console.log(`Sum DB call_duration:    ${rows.reduce((s, r) => s + (r.call_duration || 0), 0)} secs`);
console.log(`Sum API duration for those rows: ${durationFromApi} secs`);

await client.end();
