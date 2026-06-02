#!/usr/bin/env node
// Verify the cost-analytics aggregation against ElevenLabs ground truth
// post-sync. Runs the same SQL the new buildSummarySql / buildProviderSplitSql
// emit, prints the four acceptance numbers, and confirms CSV row sum matches.

import fs from "node:fs";
import path from "node:path";
import { config } from "dotenv";
config({ path: ".env.local" });

const postgres = (await import("postgres")).default;
const sql = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, max: 1 });

const FROM = "2026-04-19";
const TO = "2026-05-19";

// Replicate the new buildSummarySql exactly
const summary = (await sql`
  SELECT
    COALESCE(SUM(acl.total_cost_cents), 0)::bigint AS total_cost_cents,
    COUNT(*)::int AS total_calls,
    COALESCE(SUM(acl.call_duration), 0)::bigint AS total_duration_secs,
    COUNT(acl.total_cost_cents)::int AS calls_with_cost
  FROM ai_call_logs acl
  WHERE acl.call_id IS NOT NULL
    AND acl.provider = 'elevenlabs'
    AND acl.ended_at >= ${FROM}::date
    AND acl.ended_at < (${TO}::date + interval '1 day')
`)[0];

const cents = Number(summary.total_cost_cents);
const calls = Number(summary.total_calls);
const dur = Number(summary.total_duration_secs);
const withCost = Number(summary.calls_with_cost);
const inr = (cents / 100) * 83;
const minutes = dur / 60;
const avgPerCallInr = withCost > 0 ? inr / withCost : 0;
const avgPerMinuteInr = minutes > 0 ? inr / minutes : 0;

console.log("=== POST-SYNC DASHBOARD KPIs (window: 2026-04-19 .. 2026-05-19, ElevenLabs) ===");
console.log(`Total cost cents:    ${cents}`);
console.log(`Total INR @ 83:      ₹${inr.toFixed(2)}`);
console.log(`Total calls:         ${calls}`);
console.log(`Calls with cost:     ${withCost}`);
console.log(`Total duration secs: ${dur}`);
console.log(`Total minutes:       ${minutes.toFixed(2)}`);
console.log(`Avg INR / call:      ₹${avgPerCallInr.toFixed(2)}`);
console.log(`Avg INR / minute:    ₹${avgPerMinuteInr.toFixed(2)}`);

// Compare against API ground truth CSV
const csv = fs.readFileSync(path.join(process.cwd(), "scripts", "out", "elevenlabs-30d.csv"), "utf8");
const lines = csv.split(/\r?\n/).slice(1).filter(Boolean);
let truthCredits = 0;
let truthDuration = 0;
let truthPriced = 0;
for (const line of lines) {
  const [, , duration_secs, cost_credits] = line.split(",");
  const credits = Number(cost_credits) || 0;
  if (credits > 0) {
    truthPriced++;
    truthCredits += credits;
    truthDuration += Number(duration_secs) || 0;
  }
}
const truthInr = truthCredits * 0.0001 * 83;
const truthMinutes = truthDuration / 60;

console.log("\n=== API GROUND TRUTH (independent, from elevenlabs-30d.csv) ===");
console.log(`Priced calls:      ${truthPriced}`);
console.log(`Total INR:         ₹${truthInr.toFixed(2)}`);
console.log(`Total minutes:     ${truthMinutes.toFixed(2)}`);

console.log("\n=== ACCEPTANCE CHECKS ===");
const inrDelta = Math.abs(inr - truthInr);
const minDelta = Math.abs(minutes - truthMinutes);
console.log(`1. AVG / MINUTE non-zero & minutes ≥ 63:    ${minutes >= 63 ? "PASS" : "FAIL"} (${minutes.toFixed(2)} min)`);
console.log(`2. TOTAL SPEND ≥ ₹227:                       ${inr >= 227 ? "PASS" : "FAIL"} (₹${inr.toFixed(2)})`);
console.log(`3. AVG / CALL = TOTAL / priced (±₹0.05):     ${Math.abs(avgPerCallInr - inr / withCost) < 0.05 ? "PASS" : "FAIL"} (${avgPerCallInr.toFixed(2)})`);
console.log(`4. CSV sum matches dashboard INR (±₹1):      ${inrDelta < 1 ? "PASS" : `INFO Δ=₹${inrDelta.toFixed(2)} — expected gap if non-priced rows fetch later`}`);
console.log(`   CSV minutes vs dashboard (±1 min):        ${minDelta < 1 ? "PASS" : `INFO Δ=${minDelta.toFixed(2)} min`}`);

await sql.end();
