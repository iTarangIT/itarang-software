#!/usr/bin/env node
// One-off: re-base the historical Bolna ai_call_logs rows from USD cents to
// INR paise, matching the single-currency model (E-125). Bolna invoices this
// account in USD; ElevenLabs in INR. Future Bolna calls are converted at
// fetch time (src/lib/ai/bolna_ai/fetchCallCost.ts); this script fixes the
// rows captured before that code shipped.
//
// Idempotent: the `cost_currency = 'USD'` guard makes a re-run a no-op.
//
// Env: DATABASE_URL, USD_TO_INR_RATE (optional, default 96.86)
//
// Run:  node scripts/migrate-bolna-cost-to-inr.mjs

import { config } from "dotenv";
config({ path: ".env.local" });

const postgres = (await import("postgres")).default;
const sql = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, max: 1 });

const RATE = Number(process.env.USD_TO_INR_RATE || 96.86);
// USD cents x (INR/USD) = INR paise (the /100 and x100 cancel).
const conv = (c) => (c == null ? null : Math.round(c * RATE));

const rows = await sql`
  SELECT call_id, total_cost_cents, llm_cost_cents, tts_cost_cents,
         stt_cost_cents, telephony_cost_cents, platform_cost_cents
  FROM ai_call_logs
  WHERE provider = 'bolna' AND cost_currency = 'USD'
`;
console.log(`[bolna] ${rows.length} row(s) to convert at ${RATE} INR/USD`);

let updated = 0;
for (const r of rows) {
  const total = conv(r.total_cost_cents);
  await sql`
    UPDATE ai_call_logs SET
      total_cost_cents     = ${total},
      llm_cost_cents       = ${conv(r.llm_cost_cents)},
      tts_cost_cents       = ${conv(r.tts_cost_cents)},
      stt_cost_cents       = ${conv(r.stt_cost_cents)},
      telephony_cost_cents = ${conv(r.telephony_cost_cents)},
      platform_cost_cents  = ${conv(r.platform_cost_cents)},
      cost_currency        = 'INR',
      updated_at           = now()
    WHERE call_id = ${r.call_id} AND cost_currency = 'USD'
  `;
  updated++;
  console.log(`  ${r.call_id}: ${r.total_cost_cents} USD cents -> ${total} INR paise`);
}
console.log(`[bolna] done: ${updated} row(s) converted to INR.`);
await sql.end();
