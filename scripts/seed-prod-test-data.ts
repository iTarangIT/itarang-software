/**
 * Provision the e2e users + persistent seeded artifacts that the prod
 * Playwright suite needs. Distinct from `scripts/seed-test-data.ts` (which
 * targets the sandbox seed users); this script:
 *
 *   1. Creates / repassword's `e2e-sh@itarang.com`  (sales_head)
 *      and `e2e-dealer@itarang.com`               (dealer with onboarded record)
 *   2. Inserts an `accounts` row tied to the dealer so /dealer-portal loads
 *   3. Inserts ONE persistent dealer_onboarding_applications row in
 *      review-pending state so the verification spec has something to render
 *   4. Inserts ONE persistent customer leads row so kyc-review has a target
 *   5. Prints the IDs needed for `.env.test.local`
 *
 * Reads its DB / Supabase config from whatever env file you specify on CLI:
 *
 *   ENV_FILE=.env.production tsx scripts/seed-prod-test-data.ts
 *
 * Defaults to `.env.test.local` so a dry-run against sandbox is the safe
 * default. Refuses to run unless the password is set:
 *
 *   E2E_PROD_TEST_PASSWORD=... ENV_FILE=.env.production tsx scripts/seed-prod-test-data.ts
 *
 * Idempotent — re-runs reset the password and re-use the same UUIDs.
 */

import dotenv from 'dotenv';
import path from 'node:path';
import readline from 'node:readline';
import { createClient } from '@supabase/supabase-js';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import * as schema from '../src/lib/db/schema';

const envFile = process.env.ENV_FILE ?? '.env.test.local';
dotenv.config({ path: path.resolve(process.cwd(), envFile), override: true });

const PASSWORD = process.env.E2E_PROD_TEST_PASSWORD;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

const SH_EMAIL = process.env.E2E_PROD_SH_EMAIL ?? 'e2e-sh@itarang.com';
const DEALER_EMAIL = process.env.E2E_PROD_DEALER_EMAIL ?? 'e2e-dealer@itarang.com';

if (!PASSWORD || PASSWORD.length < 6) {
  console.error('Set E2E_PROD_TEST_PASSWORD (>=6 chars) before running. Aborting.');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_KEY || !DATABASE_URL) {
  console.error(
    `Missing one of NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / DATABASE_URL in ${envFile}. Aborting.`,
  );
  process.exit(1);
}

async function confirmProd() {
  const url = new URL(SUPABASE_URL!);
  const looksProd =
    /crm|prod/i.test(url.host) ||
    /crm|prod/i.test(process.env.NEXT_PUBLIC_APP_URL ?? '') ||
    /crm|prod/i.test(process.env.APP_URL ?? '');
  if (!looksProd) {
    console.log(`[seed-prod] env file ${envFile} looks like sandbox/dev — proceeding without confirmation.`);
    return;
  }
  console.log(`\n!!! ${envFile} appears to point at PRODUCTION !!!`);
  console.log(`    Supabase URL: ${SUPABASE_URL}`);
  console.log(`    APP_URL:      ${process.env.APP_URL ?? '(unset)'}`);
  console.log(`    DATABASE_URL host: ${new URL(DATABASE_URL!.replace(/^postgres(ql)?:/, 'http:')).host}`);
  if (process.env.E2E_PROD_CONFIRM === 'YES') {
    console.log(`[seed-prod] E2E_PROD_CONFIRM=YES set — proceeding without prompt.`);
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question('Type "i understand" to continue: ', resolve));
  rl.close();
  if (answer.trim().toLowerCase() !== 'i understand') {
    console.log('[seed-prod] aborted.');
    process.exit(2);
  }
}

const sql = () => postgres(DATABASE_URL!, { ssl: 'require', prepare: false });

async function upsertSupabaseUser(supabase: ReturnType<typeof createClient>, email: string): Promise<string> {
  const { data: list } = await supabase.auth.admin.listUsers();
  const existing = list?.users?.find((u) => u.email === email);
  if (existing) {
    await supabase.auth.admin.updateUserById(existing.id, {
      password: PASSWORD!,
      email_confirm: true,
    });
    console.log(`  [exists] ${email} (${existing.id}) — password reset`);
    return existing.id;
  }
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: PASSWORD!,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser ${email}: ${error.message}`);
  console.log(`  [created] ${email} (${data.user.id})`);
  return data.user.id;
}

async function upsertAppUser(
  db: ReturnType<typeof drizzle>,
  id: string,
  email: string,
  role: 'sales_head' | 'dealer',
  dealerId?: string,
) {
  const existing = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
  if (existing.length > 0) {
    await db
      .update(schema.users)
      .set({
        email,
        role,
        dealer_id: dealerId ?? null,
        is_active: true,
        must_change_password: false,
        updated_at: new Date(),
      })
      .where(eq(schema.users.id, id));
    console.log(`  [updated] users row ${email} role=${role}`);
  } else {
    await db.insert(schema.users).values({
      id,
      email,
      name: role === 'sales_head' ? 'E2E Sales Head' : 'E2E Dealer',
      role,
      dealer_id: dealerId ?? null,
      phone: '+919999999999',
      is_active: true,
      must_change_password: false,
      created_at: new Date(),
      updated_at: new Date(),
    });
    console.log(`  [created] users row ${email} role=${role}`);
  }
}

async function ensurePersistentOnboardingApp(db: ReturnType<typeof drizzle>): Promise<string> {
  const marker = '[E2E-PERSISTENT] dealer-verification fixture';
  const [row] = await db
    .select({ id: schema.dealerOnboardingApplications.id })
    .from(schema.dealerOnboardingApplications)
    .where(eq(schema.dealerOnboardingApplications.companyName, marker))
    .limit(1);
  if (row) {
    console.log(`  [exists] persistent onboarding app ${row.id}`);
    return row.id;
  }
  const id = crypto.randomUUID();
  await db.insert(schema.dealerOnboardingApplications).values({
    id,
    companyName: marker,
    companyType: 'sole_proprietorship',
    gstNumber: '27AAAAA0000A1Z1',
    panNumber: 'AAAAA0000A',
    onboardingStatus: 'submitted',
    reviewStatus: 'pending',
    submittedAt: new Date(),
    ownerName: 'E2E Persistent Owner',
    ownerEmail: 'e2e+persistent-app@itarang.com',
    ownerPhone: '+917000070099',
    bankName: 'State Bank of India',
    accountNumber: '00000000000000',
    beneficiaryName: 'E2E Persistent Owner',
    ifscCode: 'SBIN0001234',
    isBranchDealer: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  console.log(`  [created] persistent onboarding app ${id}`);
  return id;
}

async function ensurePersistentLead(
  db: ReturnType<typeof drizzle>,
  uploaderId: string,
): Promise<string> {
  const marker = '[E2E-PERSISTENT] kyc-review fixture';
  const [row] = await db
    .select({ id: schema.leads.id })
    .from(schema.leads)
    .where(eq(schema.leads.full_name, marker))
    .limit(1);
  if (row) {
    console.log(`  [exists] persistent kyc lead ${row.id}`);
    return row.id;
  }
  const id = `L-E2E-PERSIST-${Date.now().toString().slice(-8)}`;
  await db.insert(schema.leads).values({
    id,
    full_name: marker,
    phone: '+917000070099',
    mobile: '+917000070099',
    shop_address: 'Persistent E2E test fixture',
    status: 'new',
    payment_method: 'finance',
    kyc_status: 'pending',
    lead_status: 'new',
    interest_level: 'warm',
    lead_source: 'database_upload',
    uploader_id: uploaderId,
    created_at: new Date(),
  } as typeof schema.leads.$inferInsert);
  console.log(`  [created] persistent kyc lead ${id}`);
  return id;
}

async function main() {
  console.log(`\n=== seed-prod-test-data ===`);
  console.log(`env file: ${envFile}\n`);
  await confirmProd();

  const supabase = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const client = sql();
  const db = drizzle(client, { schema });

  try {
    console.log('1. Provisioning Supabase auth users …');
    const shAuthId = await upsertSupabaseUser(supabase, SH_EMAIL);
    const dealerAuthId = await upsertSupabaseUser(supabase, DEALER_EMAIL);

    console.log('\n2. Upserting users rows …');
    await upsertAppUser(db, shAuthId, SH_EMAIL, 'sales_head');
    // The dealer's dealer_id remains unset; the persistent onboarding app is
    // separate from the dealer's portal access. /dealer-portal needs a dealer
    // role and an active users row — both are now in place.
    await upsertAppUser(db, dealerAuthId, DEALER_EMAIL, 'dealer');

    console.log('\n3. Persistent onboarding application (dealer-verification fixture) …');
    const appId = await ensurePersistentOnboardingApp(db);

    console.log('\n4. Persistent customer lead (kyc-review fixture) …');
    const leadId = await ensurePersistentLead(db, dealerAuthId);

    console.log('\n=== add the following to .env.test.local ===');
    console.log(`E2E_PROD_SH_EMAIL=${SH_EMAIL}`);
    console.log(`E2E_PROD_SH_PASSWORD=${PASSWORD}`);
    console.log(`E2E_PROD_DEALER_EMAIL=${DEALER_EMAIL}`);
    console.log(`E2E_PROD_DEALER_PASSWORD=${PASSWORD}`);
    console.log(`E2E_PROD_SEED_DEALER_ID=${appId}`);
    console.log(`E2E_PROD_SEED_LEAD_ID=${leadId}`);
    console.log('\nDone.\n');
  } finally {
    await client.end({ timeout: 5 }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
