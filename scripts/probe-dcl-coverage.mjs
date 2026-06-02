#!/usr/bin/env node
// Check how many of the 150 ElevenLabs API conversations have a dialer_campaign_leads row.

import fs from "node:fs";
import path from "node:path";
import { config } from "dotenv";
config({ path: ".env.local" });
const postgres = (await import("postgres")).default;
const sql = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, max: 1 });

const groundTruth = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "scripts", "out", "elevenlabs-30d.json"), "utf8"),
);
const apiIds = groundTruth.map((r) => r.conversation_id);
const priced = groundTruth.filter((r) => r.cost_credits > 0);
const pricedIds = priced.map((r) => r.conversation_id);

const dclRows = await sql`
  SELECT bolna_call_id, campaign_id, status, completed_at
  FROM dialer_campaign_leads
  WHERE bolna_call_id = ANY(${apiIds})
`;
console.log(`API conversations: ${apiIds.length} (priced: ${pricedIds.length})`);
console.log(`Of those, in dialer_campaign_leads: ${dclRows.length}`);

const dclIds = new Set(dclRows.map((r) => r.bolna_call_id));
const pricedInDcl = priced.filter((r) => dclIds.has(r.conversation_id));
const pricedNotInDcl = priced.filter((r) => !dclIds.has(r.conversation_id));
console.log(`Priced calls in DCL: ${pricedInDcl.length}`);
console.log(`Priced calls NOT in DCL: ${pricedNotInDcl.length}`);

const pricedCreditsInDcl = pricedInDcl.reduce((s, r) => s + r.cost_credits, 0);
const pricedCreditsNotInDcl = pricedNotInDcl.reduce((s, r) => s + r.cost_credits, 0);
console.log(`Sum credits in DCL:     ${pricedCreditsInDcl} (₹${(pricedCreditsInDcl * 0.0001 * 83).toFixed(2)})`);
console.log(`Sum credits NOT in DCL: ${pricedCreditsNotInDcl} (₹${(pricedCreditsNotInDcl * 0.0001 * 83).toFixed(2)})`);

// Of the in-DCL priced calls, how many have ai_call_logs?
const aclSql = await sql`
  SELECT call_id, call_duration, total_cost_cents
  FROM ai_call_logs
  WHERE provider = 'elevenlabs'
    AND call_id = ANY(${pricedInDcl.map(r => r.conversation_id)})
`;
console.log(`\nOf ${pricedInDcl.length} priced+in-DCL calls, ai_call_logs has ${aclSql.length}`);
const aclIds = new Set(aclSql.map((r) => r.call_id));
const missingFromAcl = pricedInDcl.filter((r) => !aclIds.has(r.conversation_id));
console.log(`Priced + in-DCL but missing from ai_call_logs: ${missingFromAcl.length}`);

// Duration check on those that ARE in ai_call_logs
const withDur = aclSql.filter((r) => r.call_duration > 0);
console.log(`Priced + in-DCL + in ai_call_logs WITH duration: ${withDur.length}`);
console.log(`Priced + in-DCL + in ai_call_logs WITHOUT duration: ${aclSql.length - withDur.length}`);

// Total ground truth for in-DCL priced calls
const groundTotalInr = pricedCreditsInDcl * 0.0001 * 83;
const groundTotalMin = pricedInDcl.reduce((s, r) => s + (r.duration_secs || 0), 0) / 60;
console.log(`\nIF dashboard included ALL ${pricedInDcl.length} priced+in-DCL calls correctly:`);
console.log(`  Total: ₹${groundTotalInr.toFixed(2)}`);
console.log(`  Minutes: ${groundTotalMin.toFixed(2)}`);

await sql.end();
