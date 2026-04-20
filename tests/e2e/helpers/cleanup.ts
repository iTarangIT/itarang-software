/**
 * Standalone cleanup script for the full-flow orchestrator.
 *
 *   npx tsx tests/e2e/helpers/cleanup.ts
 *
 * Removes:
 *   - dealer onboarding applications + documents whose company_name starts with "Playwright Test Co"
 *   - dealer users created from those applications (both Supabase auth + app users table)
 *   - leads created with the test phone number
 *
 * Safe — keys off deterministic prefixes; never truncates whole tables.
 */

import dotenv from 'dotenv';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env.test.local'), override: true });

const COMPANY_PREFIX = 'Playwright Test Co';
const PHONE_FROM_ENV = (process.env.E2E_TEST_PHONE_NUMBER || '').replace(/^\+/, '').replace(/[^0-9]/g, '');

const DATABASE_URL = process.env.DATABASE_URL!;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!DATABASE_URL || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing DATABASE_URL / NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { ssl: 'require', prepare: false });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

async function main() {
  console.log(`\n=== iTarang E2E cleanup ===\nCompany prefix: "${COMPANY_PREFIX}"\nPhone (digits only): ${PHONE_FROM_ENV || '(none — phone leg skipped)'}\n`);

  const apps = await sql<{ id: string; dealer_id: string | null; owner_email: string | null }[]>`
    SELECT id, dealer_id, owner_email
    FROM dealer_onboarding_applications
    WHERE company_name LIKE ${COMPANY_PREFIX + '%'}
  `;
  // Note: dealer_id and owner_email column names match the SQL schema directly.
  console.log(`Onboarding applications matched: ${apps.length}`);

  for (const app of apps) {
    await sql`DELETE FROM dealer_onboarding_documents WHERE application_id = ${app.id}`;
  }
  if (apps.length > 0) {
    await sql`DELETE FROM dealer_onboarding_applications WHERE company_name LIKE ${COMPANY_PREFIX + '%'}`;
  }

  const dealerEmails = apps.map((a) => a.owner_email).filter((e): e is string => !!e);
  if (dealerEmails.length > 0) {
    await sql`DELETE FROM users WHERE email = ANY(${dealerEmails as any})`;
    const { data: list } = await supabase.auth.admin.listUsers();
    for (const u of list?.users ?? []) {
      if (u.email && dealerEmails.includes(u.email)) {
        await supabase.auth.admin.deleteUser(u.id);
        console.log(`  deleted auth user ${u.email}`);
      }
    }
  }

  if (PHONE_FROM_ENV) {
    const leads = await sql`DELETE FROM leads WHERE phone = ${PHONE_FROM_ENV} RETURNING id`;
    console.log(`Leads deleted by phone ${PHONE_FROM_ENV}: ${leads.length}`);
  }

  await sql.end({ timeout: 5 });
  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
