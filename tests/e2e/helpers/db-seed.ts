import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../../src/lib/db/schema';

/**
 * Test-owned DB seed + cleanup helpers. Designed for Playwright fixtures that
 * need a real row to exist before a page loads (e.g. /admin/kyc-review/[leadId]
 * needs a lead row).
 *
 * Keeps its own postgres connection — parallel to dealer-creds.ts — so a single
 * fixture can seed in beforeAll and teardown in afterAll without stepping on
 * the helper used by other specs.
 */

type Client = { db: ReturnType<typeof drizzle>; sql: ReturnType<typeof postgres> };

let _client: Client | null = null;

function getClient(): Client {
  if (_client) return _client;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL must be set in .env.test.local');
  const sql = postgres(dbUrl, { ssl: 'require', prepare: false });
  const db = drizzle(sql, { schema });
  _client = { db, sql };
  return _client;
}

export async function closeDbSeedClient(): Promise<void> {
  if (_client) {
    await _client.sql.end({ timeout: 5 }).catch(() => {});
  }
  _client = null;
}

/**
 * Seed a dealer_leads row scoped to the test. Returns the generated id.
 * Idempotent on phone — deletes any pre-existing row with the same phone first.
 */
export async function seedDealerLead(params: {
  phone: string;
  dealer_name: string;
  shop_name?: string;
  location?: string;
  language?: string;
}): Promise<string> {
  const { db } = getClient();
  const {
    phone,
    dealer_name,
    shop_name = 'E2E Test Shop',
    location = 'Pune, Maharashtra',
    language = 'hindi',
  } = params;

  await db.delete(schema.dealerLeads).where(eq(schema.dealerLeads.phone, phone));
  const id = `L-E2E-${Date.now().toString().slice(-8)}`;
  await db.insert(schema.dealerLeads).values({
    id,
    dealer_name,
    shop_name,
    phone,
    location,
    language,
    current_status: 'new',
    total_attempts: 0,
    follow_up_history: [],
    created_at: new Date(),
  });
  return id;
}

/** Remove a dealer_leads row by id. Safe to call even if not present. */
export async function cleanupDealerLead(id: string): Promise<void> {
  const { db } = getClient();
  await db.delete(schema.dealerLeads).where(eq(schema.dealerLeads.id, id));
}

/**
 * Seed a customer-lead row (`leads` table) — the entity that admin KYC review
 * looks up via /admin/kyc-review/[leadId]. Required fields are minimal: id,
 * full_name, phone, status. We also set payment_method='finance' so downstream
 * flows treat it as a KYC-track lead.
 */
export async function seedCustomerLead(params: {
  full_name: string;
  phone: string;
  shop_address?: string;
  payment_method?: 'finance' | 'upfront' | 'cash';
  status?: string;
}): Promise<string> {
  const { db } = getClient();
  const {
    full_name,
    phone,
    shop_address = '221B Test Street, Pune, Maharashtra 411001',
    payment_method = 'finance',
    status = 'new',
  } = params;

  await db.delete(schema.leads).where(eq(schema.leads.phone, phone));
  const id = `L-E2E-${Date.now().toString().slice(-8)}`;
  await db.insert(schema.leads).values({
    id,
    full_name,
    phone,
    mobile: phone,
    shop_address,
    status,
    payment_method,
    kyc_status: 'pending',
    lead_status: 'new',
    interest_level: 'warm',
    created_at: new Date(),
  } as typeof schema.leads.$inferInsert);
  return id;
}

/** Remove a `leads` row by id. Safe to call even if not present. */
export async function cleanupCustomerLead(id: string): Promise<void> {
  const { db } = getClient();
  await db.delete(schema.leads).where(eq(schema.leads.id, id));
}

/** Remove a kyc_verifications row for a given (lead_id, verification_type). */
export async function cleanupKycVerification(params: {
  leadId: string;
  type: 'pan' | 'aadhaar' | 'bank' | 'cibil' | 'rc';
}): Promise<void> {
  const { db } = getClient();
  await db
    .delete(schema.kycVerifications)
    .where(eq(schema.kycVerifications.lead_id, params.leadId));
}

/**
 * Read the latest kyc_verifications row for assertion after a test triggers
 * a verification call. Returns null if nothing persisted.
 */
export async function getKycVerification(params: {
  leadId: string;
  type: 'pan' | 'aadhaar' | 'bank' | 'cibil' | 'rc';
}) {
  const { db } = getClient();
  const rows = await db
    .select()
    .from(schema.kycVerifications)
    .where(eq(schema.kycVerifications.lead_id, params.leadId))
    .limit(10);
  return rows.find((r) => r.verification_type === params.type) ?? null;
}
