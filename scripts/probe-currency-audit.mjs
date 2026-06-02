#!/usr/bin/env node
// Pre-flight audit before collapsing total_cost_cents to a single currency
// (INR paise). Shows per-provider cost coverage + the cost_currency values
// currently stored, so the re-sync knows exactly which rows it must rewrite.
//
// Env: DATABASE_URL

import { config } from "dotenv";
config({ path: ".env.local" });

const postgres = (await import("postgres")).default;
const sql = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, max: 1 });

const byProvider = await sql`
  SELECT
    provider,
    cost_currency,
    COUNT(*)::int                          AS rows,
    COUNT(total_cost_cents)::int           AS with_cost,
    COALESCE(SUM(total_cost_cents),0)::bigint AS sum_cost_cents,
    MIN(ended_at)::date                    AS earliest,
    MAX(ended_at)::date                    AS latest
  FROM ai_call_logs
  WHERE call_id IS NOT NULL
  GROUP BY provider, cost_currency
  ORDER BY provider, cost_currency
`;

console.log("=== ai_call_logs cost rows by provider × currency ===");
for (const r of byProvider) {
  console.log(
    `  provider=${r.provider ?? "<null>"}  currency=${r.cost_currency ?? "<null>"}  ` +
      `rows=${r.rows}  with_cost=${r.with_cost}  sum_cents=${r.sum_cost_cents}  ` +
      `(${r.earliest ?? "-"} .. ${r.latest ?? "-"})`,
  );
}

const bolnaPriced = await sql`
  SELECT COUNT(*)::int AS n
  FROM ai_call_logs
  WHERE provider = 'bolna' AND total_cost_cents IS NOT NULL AND total_cost_cents > 0
`;
console.log(`\nBolna rows with a non-zero cost (need USD→INR re-conversion): ${bolnaPriced[0].n}`);

await sql.end();
