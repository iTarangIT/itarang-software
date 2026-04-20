import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import * as schema from '../../../src/lib/db/schema';

export type NewDealerCreds = {
  email: string;
  password: string;
  authUserId: string;
  dealerCode: string | null;
};

const TEMP_PASSWORD = 'E2EFlow@1234';

let _supabase: SupabaseClient | null = null;
let _db: ReturnType<typeof drizzle> | null = null;
let _sql: ReturnType<typeof postgres> | null = null;

function getClients() {
  if (!_supabase) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    if (!url || !key) {
      throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY must be set in .env.test.local');
    }
    _supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  }
  if (!_db) {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error('DATABASE_URL must be set in .env.test.local');
    _sql = postgres(dbUrl, { ssl: 'require', prepare: false });
    _db = drizzle(_sql, { schema });
  }
  return { supabase: _supabase, db: _db! };
}

export async function closeDealerCredsClients() {
  if (_sql) await _sql.end({ timeout: 5 });
  _sql = null;
  _db = null;
  _supabase = null;
}

/**
 * After the approve API has run, look up the new dealer user, set a known
 * password and clear must_change_password so window 2 can log in.
 *
 * Approve route only returns dealerCode/authUserId — it does not return the
 * temp password (it's emailed). This helper bypasses the email by directly
 * resetting via the Supabase admin SDK.
 */
export async function provisionKnownDealerPassword(
  authUserId: string,
  dealerCode: string | null,
): Promise<NewDealerCreds> {
  const { supabase, db } = getClients();

  const { data: user, error: getErr } = await supabase.auth.admin.getUserById(authUserId);
  if (getErr || !user?.user) {
    throw new Error(`Failed to fetch auth user ${authUserId}: ${getErr?.message ?? 'not found'}`);
  }
  const email = user.user.email!;

  const { error: updateErr } = await supabase.auth.admin.updateUserById(authUserId, {
    password: TEMP_PASSWORD,
    email_confirm: true,
  });
  if (updateErr) {
    throw new Error(`Failed to set known password for ${email}: ${updateErr.message}`);
  }

  await db
    .update(schema.users)
    .set({ must_change_password: false, is_active: true, updated_at: new Date() })
    .where(eq(schema.users.id, authUserId));

  return { email, password: TEMP_PASSWORD, authUserId, dealerCode };
}

/**
 * Look up the most recent dealer_onboarding_applications row matching a unique
 * company name. Used in Phase A.1 because the wizard redirects immediately on
 * submit, which discards the JSON response body before Playwright can read it.
 */
export async function findApplicationIdByCompanyName(companyName: string): Promise<string> {
  const { db } = getClients();
  const [row] = await db
    .select({ id: schema.dealerOnboardingApplications.id })
    .from(schema.dealerOnboardingApplications)
    .where(eq(schema.dealerOnboardingApplications.companyName, companyName))
    .limit(1);
  if (!row) throw new Error(`no dealer_onboarding_applications row with company_name="${companyName}"`);
  return row.id;
}

/**
 * Seed a dealer_leads row keyed by phone so /api/bolna/call can find it.
 * triggerBolnaCall only looks at dealer_leads / scraper_leads, not the
 * customer leads table — to dial our test phone via Bolna we need a row here.
 * Idempotent: deletes any existing dealer_leads row with the same phone first.
 */
export async function seedDealerLeadForPhone(opts: {
  phone: string;
  dealer_name: string;
  shop_name: string;
  location: string;
  language?: string;
}): Promise<string> {
  const { db } = getClients();
  await db.delete(schema.dealerLeads).where(eq(schema.dealerLeads.phone, opts.phone));
  const id = `L-PW-${Date.now().toString().slice(-8)}`;
  await db.insert(schema.dealerLeads).values({
    id,
    dealer_name: opts.dealer_name,
    shop_name: opts.shop_name,
    phone: opts.phone,
    location: opts.location,
    language: opts.language ?? 'hindi',
    current_status: 'new',
    total_attempts: 0,
    follow_up_history: [],
    created_at: new Date(),
  });
  return id;
}

/**
 * Read the Bolna-relevant fields from a dealer_leads row by phone — used in
 * Phase E to assert the call/transcript pipeline updated the row.
 */
export async function getDealerLeadByPhone(phone: string) {
  const { db } = getClients();
  const [row] = await db
    .select()
    .from(schema.dealerLeads)
    .where(eq(schema.dealerLeads.phone, phone))
    .limit(1);
  return row ?? null;
}
