#!/usr/bin/env node
// Reconcile the Cost Analytics panels against each other for a given window:
// does SUM(component cents) equal SUM(total_cost_cents)? ElevenLabs reports a
// single `metadata.cost` plus partial `llm_charge` / `call_charge` breakdown,
// so the component panel and the Total Spend KPI can legitimately diverge.
// This quantifies the gap so the dashboard footnote can be accurate.
//
// Env: DATABASE_URL, FROM (default 2026-04-20), TO (default 2026-05-20)

import { config } from "dotenv";
config({ path: ".env.local" });

const postgres = (await import("postgres")).default;
const sql = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, max: 1 });

const FROM = process.env.FROM || "2026-04-20";
const TO = process.env.TO || "2026-05-20";
// total_cost_cents is INR paise (E-125) — no FX conversion.

const r = (
  await sql`
  SELECT
    COALESCE(SUM(total_cost_cents),0)::bigint   AS total,
    COALESCE(SUM(llm_cost_cents),0)::bigint      AS llm,
    COALESCE(SUM(tts_cost_cents),0)::bigint      AS tts,
    COALESCE(SUM(stt_cost_cents),0)::bigint      AS stt,
    COALESCE(SUM(telephony_cost_cents),0)::bigint AS telephony,
    COALESCE(SUM(platform_cost_cents),0)::bigint AS platform,
    COUNT(*)::int                                AS calls,
    COUNT(total_cost_cents)::int                 AS with_cost,
    COALESCE(SUM(call_duration),0)::bigint        AS dur
  FROM ai_call_logs
  WHERE call_id IS NOT NULL AND provider = 'elevenlabs'
    AND ended_at >= ${FROM}::date
    AND ended_at < (${TO}::date + interval '1 day')
`
)[0];

const inr = (c) => `₹${(Number(c) / 100).toFixed(2)}`;
const total = Number(r.total);
const compSum = Number(r.llm) + Number(r.tts) + Number(r.stt) + Number(r.telephony) + Number(r.platform);
const gap = total - compSum;
const min = Number(r.dur) / 60;

console.log(`=== window ${FROM} .. ${TO}  provider=elevenlabs ===`);
console.log(`TOTAL SPEND (KPI)   ${inr(total)}   (${total} cents)`);
console.log(`calls=${r.calls}  with_cost=${r.with_cost}  duration=${min.toFixed(2)} min`);
console.log(`avg/call=${inr(Number(r.with_cost) > 0 ? total / Number(r.with_cost) : 0)}`);
console.log(`avg/min =₹${min > 0 ? ((total / 100) / min).toFixed(2) : "0.00"}`);
console.log("");
console.log("--- component panel ---");
console.log(`  LLM        ${inr(r.llm)}`);
console.log(`  TTS        ${inr(r.tts)}`);
console.log(`  STT        ${inr(r.stt)}`);
console.log(`  Telephony  ${inr(r.telephony)}`);
console.log(`  Platform   ${inr(r.platform)}`);
console.log(`  SUM        ${inr(compSum)}   (${compSum} cents)`);
console.log("");
console.log(`GAP (total - components) = ${inr(gap)}  (${gap} cents)  = ${total > 0 ? ((gap / total) * 100).toFixed(2) : 0}% of total`);

await sql.end();
