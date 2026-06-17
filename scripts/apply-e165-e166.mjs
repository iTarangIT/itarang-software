#!/usr/bin/env node
// Apply E-165 + E-166 (additive, idempotent) to the active DATABASE_URL.
// Fixes /nbfc/settings (nbfc_service_config missing endpoint/secret/esign_provider
// columns) and /api/nbfc/sanction ("provider_type does not exist").
import fs from "node:fs";
import path from "node:path";
import { config } from "dotenv";
config({ path: ".env.local" });

const postgres = (await import("postgres")).default;
const sql = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, max: 1 });

const host = (process.env.DATABASE_URL || "").match(/@([^/:]+)/)?.[1];
console.log(`DB host: ${host}\n`);

const files = [
  "drizzle/E-165_nbfc_byo_provider_handoff.sql",
  "drizzle/E-166_nbfc_provider_credentials.sql",
];

try {
  for (const f of files) {
    const text = fs.readFileSync(path.join(process.cwd(), f), "utf8");
    console.log(`Applying ${f} ...`);
    await sql.unsafe(text).simple(); // simple protocol → allows multiple statements / DO blocks
    console.log(`  ✓ applied (idempotent)`);
  }

  // Verify the previously-missing columns now exist
  const cols = await sql`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE (table_name = 'nbfc_service_config'
             AND column_name IN ('vkyc_endpoint_url','esign_endpoint_url',
               'vkyc_webhook_secret','enach_webhook_secret','esign_webhook_secret','esign_provider'))
       OR (table_name = 'nbfc_loan_agreements' AND column_name = 'provider_type')
    ORDER BY table_name, column_name
  `;
  console.log(`\nVerification — columns now present:`);
  console.table(cols);
} finally {
  await sql.end();
}
