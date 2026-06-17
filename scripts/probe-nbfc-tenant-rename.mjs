#!/usr/bin/env node
// Rename an NBFC partner (display + legal name) keyed by login email.
// Safe: aborts unless EXACTLY ONE tenant matches. Prints before/after.
import { config } from "dotenv";
config({ path: ".env.local" });

const postgres = (await import("postgres")).default;
const sql = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, max: 1 });

const EMAIL = "2ThTa4089@AllFreeMail.net";
const NEW_NAME = "iTarang Finance";

const host = (process.env.DATABASE_URL || "").match(/@([^/:]+)/)?.[1];
console.log(`DB host: ${host}\n`);

try {
  // 1. Resolve tenant(s) for this login email (email match is case-insensitive guard)
  const matches = await sql`
    SELECT t.id AS tenant_id, t.slug, t.display_name, t.nbfc_legal_name, u.email
    FROM nbfc_users nu
    JOIN nbfc_tenants t ON t.id = nu.tenant_id
    JOIN users u        ON u.id = nu.user_id
    WHERE lower(u.email) = lower(${EMAIL})
  `;

  console.log(`Matched ${matches.length} tenant(s) BEFORE:`);
  console.table(matches);

  if (matches.length !== 1) {
    console.error(`\nABORTING: expected exactly 1 tenant, got ${matches.length}. No changes made.`);
    process.exit(1);
  }

  const tenantId = matches[0].tenant_id;

  // 2. Update both portal display name and legal/compliance name
  await sql`
    UPDATE nbfc_tenants
    SET display_name = ${NEW_NAME}, nbfc_legal_name = ${NEW_NAME}
    WHERE id = ${tenantId}
  `;
  const nbfcUpd = await sql`
    UPDATE nbfc
    SET legal_name = ${NEW_NAME}
    WHERE tenant_id = ${tenantId}
    RETURNING id
  `;
  console.log(`\nUpdated nbfc_tenants (1 row) + nbfc legacy rows (${nbfcUpd.length}).`);

  // 3. Show after state
  const after = await sql`
    SELECT id AS tenant_id, slug, display_name, nbfc_legal_name
    FROM nbfc_tenants WHERE id = ${tenantId}
  `;
  console.log(`\nAFTER:`);
  console.table(after);
  console.log(`\nDone. Refresh localhost:3000/nbfc to see "${NEW_NAME}".`);
} finally {
  await sql.end();
}
