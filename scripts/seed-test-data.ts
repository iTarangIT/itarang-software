/**
 * Test Data Seed Script
 *
 * Creates fresh test data for all flows:
 * - Test dealer user (Supabase auth + app DB)
 * - Test admin/sales_head user
 * - Dealer account
 * - Leads at various stages (hot/warm/cold, with/without KYC)
 * - KYC documents for a lead
 * - Coupon codes
 * - Dealer onboarding application
 *
 * Usage:
 *   npx tsx scripts/seed-test-data.ts
 *
 * After running, use these credentials to log in:
 *   Dealer:     test-dealer@itarang.com / Test@1234
 *   Admin:      test-admin@itarang.com  / Test@1234
 *   Sales Head: test-sh@itarang.com     / Test@1234
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import * as schema from '../src/lib/db/schema';
import { eq } from 'drizzle-orm';

const DATABASE_URL = process.env.DATABASE_URL!;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!DATABASE_URL || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing env vars: DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
}

const queryClient = postgres(DATABASE_URL, { ssl: 'require', prepare: false });
const db = drizzle(queryClient, { schema });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
});

const PASSWORD = 'Test@1234';
const NOW = new Date();
const NOW_ISO = NOW.toISOString();

// IDs
const DEALER_ACCOUNT_ID = `ACC-TEST-${Date.now()}`;
const LEAD_HOT_ID = `LEAD-TEST-HOT-${Date.now()}`;
const LEAD_WARM_ID = `LEAD-TEST-WARM-${Date.now()}`;
const LEAD_COLD_ID = `LEAD-TEST-COLD-${Date.now()}`;
const LEAD_KYC_ID = `LEAD-TEST-KYC-${Date.now()}`;
const ONBOARDING_APP_ID = crypto.randomUUID();

async function createSupabaseUser(email: string): Promise<string> {
    // Check if user exists
    const { data: existingUsers } = await supabase.auth.admin.listUsers();
    const existing = existingUsers?.users?.find(u => u.email === email);
    if (existing) {
        console.log(`  [exists] Supabase user: ${email} (${existing.id})`);
        // Update password
        await supabase.auth.admin.updateUserById(existing.id, { password: PASSWORD });
        return existing.id;
    }

    const { data, error } = await supabase.auth.admin.createUser({
        email,
        password: PASSWORD,
        email_confirm: true,
    });
    if (error) throw new Error(`Failed to create Supabase user ${email}: ${error.message}`);
    console.log(`  [created] Supabase user: ${email} (${data.user.id})`);
    return data.user.id;
}

async function upsertAppUser(id: string, data: {
    email: string; name: string; role: string; dealer_id?: string; phone?: string;
}) {
    const existing = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    if (existing.length > 0) {
        await db.update(schema.users).set({
            ...data,
            is_active: true,
            must_change_password: false,
            updated_at: NOW,
        }).where(eq(schema.users.id, id));
        console.log(`  [updated] App user: ${data.email} (${data.role})`);
    } else {
        await db.insert(schema.users).values({
            id,
            ...data,
            is_active: true,
            must_change_password: false,
            created_at: NOW,
            updated_at: NOW,
        });
        console.log(`  [created] App user: ${data.email} (${data.role})`);
    }
}

async function main() {
    console.log('\n=== iTarang Test Data Seed ===\n');

    // ─── 1. Create Users ───────────────────────────────────────────────
    console.log('1. Creating test users...');

    const dealerUserId = await createSupabaseUser('test-dealer@itarang.com');
    const adminUserId = await createSupabaseUser('test-admin@itarang.com');
    const salesHeadUserId = await createSupabaseUser('test-sh@itarang.com');

    await upsertAppUser(dealerUserId, {
        email: 'test-dealer@itarang.com',
        name: 'Rahul Sharma',
        role: 'dealer',
        dealer_id: DEALER_ACCOUNT_ID,
        phone: '9876543210',
    });
    await upsertAppUser(adminUserId, {
        email: 'test-admin@itarang.com',
        name: 'Admin User',
        role: 'admin',
        phone: '9876543211',
    });
    await upsertAppUser(salesHeadUserId, {
        email: 'test-sh@itarang.com',
        name: 'Anirudh Singhal',
        role: 'sales_head',
        phone: '9876543212',
    });

    // ─── 2. Create Dealer Account ──────────────────────────────────────
    console.log('\n2. Creating dealer account...');
    let actualDealerAccountId = DEALER_ACCOUNT_ID;
    try {
        // Check if account exists by GSTIN
        const existingAcct = await queryClient`SELECT id FROM accounts WHERE gstin = '27AABCS1234Z1Z5' LIMIT 1`;
        if (existingAcct.length > 0) {
            actualDealerAccountId = existingAcct[0].id;
            console.log(`  [exists] Dealer account: ${actualDealerAccountId}`);
        } else {
            await queryClient`
                INSERT INTO accounts (id, business_entity_name, gstin, contact_name, contact_email, contact_phone,
                    address_line1, city, state, pincode, bank_name, bank_account_number, ifsc_code,
                    status, onboarding_status, created_at, updated_at)
                VALUES (${DEALER_ACCOUNT_ID}, 'Sharma EV Motors', '27AABCS1234Z1Z5',
                    'Rahul Sharma', 'test-dealer@itarang.com', '9876543210',
                    'Shop No 12, EV Market', 'Nashik', 'Maharashtra', '422001',
                    'State Bank of India', '12345678901234', 'SBIN0001234',
                    'active', 'approved', NOW(), NOW())
            `;
            console.log(`  [created] Dealer account: ${DEALER_ACCOUNT_ID}`);
        }
        // Update user's dealer_id to match the actual account
        await db.update(schema.users).set({ dealer_id: actualDealerAccountId }).where(eq(schema.users.id, dealerUserId));
    } catch (e: any) {
        console.log(`  [error] Dealer account: ${e.message?.slice(0, 120)}`);
    }

    // ─── 3. Create Leads (raw SQL for schema compatibility) ──────────
    console.log('\n3. Creating test leads...');

    const leadsToInsert = [
        { id: LEAD_HOT_ID, ref: '#IT-2026-TEST001', name: 'Vijay Kumar', phone: '9988776655',
          addr: '45, MG Road, Pune, Maharashtra 411001', father: 'Ramesh Kumar', dob: '1990-05-15',
          interest: 'hot', payment: 'other_finance', lstatus: 'new', status: 'ACTIVE', score: 90,
          model: '3w', consent: 'awaiting_signature', kyc: 'pending', step: 2, coborrower: false,
          rc: null, vo: null, von: null, vop: null },
        { id: LEAD_WARM_ID, ref: '#IT-2026-TEST002', name: 'Priya Patel', phone: '9988776644',
          addr: '12, Station Road, Nashik, Maharashtra 422001', father: 'Suresh Patel', dob: '1985-08-20',
          interest: 'warm', payment: 'itarang_finance', lstatus: 'contacted', status: 'ACTIVE', score: 60,
          model: '2w', consent: 'awaiting_signature', kyc: 'pending', step: 1, coborrower: false,
          rc: null, vo: null, von: null, vop: null },
        { id: LEAD_COLD_ID, ref: '#IT-2026-TEST003', name: 'Amit Singh', phone: '9988776633',
          addr: '78, Laxmi Nagar, Nagpur, Maharashtra 440001', father: null, dob: '1995-01-01',
          interest: 'cold', payment: 'cash', lstatus: 'new', status: 'ACTIVE', score: 30,
          model: '2w', consent: 'awaiting_signature', kyc: null, step: 1, coborrower: false,
          rc: null, vo: null, von: null, vop: null },
        { id: LEAD_KYC_ID, ref: '#IT-2026-TEST004', name: 'Deepak Verma', phone: '9988776622',
          addr: '99, Gandhi Chowk, Aurangabad, Maharashtra 431001', father: 'Mohan Verma', dob: '1992-03-10',
          interest: 'hot', payment: 'other_finance', lstatus: 'qualified', status: 'ACTIVE', score: 95,
          model: '3w', consent: 'admin_verified', kyc: 'documents_uploaded', step: 2, coborrower: true,
          rc: 'MH 20 AB 1234', vo: 'Self', von: 'Deepak Verma', vop: '9988776622' },
    ];

    for (const l of leadsToInsert) {
        try {
            const existing = await queryClient`SELECT id FROM leads WHERE id = ${l.id} LIMIT 1`;
            if (existing.length === 0) {
                await queryClient`
                    INSERT INTO leads (id, reference_id, full_name, owner_name, phone, owner_contact,
                        current_address, permanent_address, father_or_husband_name, dob,
                        interest_level, payment_method, lead_status, status, lead_score,
                        dealer_id, asset_model, consent_status, kyc_status, workflow_step,
                        has_co_borrower, vehicle_rc, vehicle_ownership, vehicle_owner_name, vehicle_owner_phone,
                        lead_source, uploader_id, created_at, updated_at)
                    VALUES (${l.id}, ${l.ref}, ${l.name}, ${l.name}, ${l.phone}, ${l.phone},
                        ${l.addr}, ${l.addr}, ${l.father}, ${l.dob},
                        ${l.interest}, ${l.payment}, ${l.lstatus}, ${l.status}, ${l.score},
                        ${actualDealerAccountId}, ${l.model}, ${l.consent}, ${l.kyc}, ${l.step},
                        ${l.coborrower}, ${l.rc}, ${l.vo}, ${l.von}, ${l.vop},
                        'dealer_referral', ${dealerUserId}, ${NOW_ISO}, ${NOW_ISO})
                `;
                console.log(`  [created] Lead: ${l.name} (${l.interest}/${l.payment}) - ${l.id}`);
            } else {
                console.log(`  [exists] Lead: ${l.name} - ${l.id}`);
            }
        } catch (e: any) {
            console.log(`  [error] Lead ${l.name}: ${e.message?.slice(0, 120)}`);
        }
    }

    // ─── 4. Create KYC Documents for the "KYC ready" lead ──────────────
    console.log('\n4. Creating KYC documents for lead:', LEAD_KYC_ID);

    // Using a placeholder image URL for test docs
    const PLACEHOLDER_IMG = 'https://placehold.co/400x300/0047AB/white?text=Test+Doc';
    const docTypes = [
        'aadhaar_front', 'aadhaar_back', 'pan_card', 'passport_photo',
        'bank_statement', 'address_proof', 'rc_copy', 'cheque_1',
    ];

    for (const docType of docTypes) {
        const docId = `KYCDOC-TEST-${docType}-${Date.now()}`;
        try {
            const existing = await queryClient`SELECT id FROM kyc_documents WHERE lead_id = ${LEAD_KYC_ID} AND doc_type = ${docType} LIMIT 1`;
            if (existing.length === 0) {
                await queryClient`
                    INSERT INTO kyc_documents (id, lead_id, doc_type, file_url, file_name, file_size, verification_status, uploaded_at, updated_at)
                    VALUES (${docId}, ${LEAD_KYC_ID}, ${docType}, ${PLACEHOLDER_IMG}, ${'test_' + docType + '.jpg'}, 250000, 'pending', NOW(), NOW())
                `;
                console.log(`  [created] KYC doc: ${docType}`);
            } else {
                console.log(`  [exists] KYC doc: ${docType}`);
            }
        } catch (e: any) {
            console.log(`  [skipped] KYC doc: ${docType} - ${e.message?.slice(0, 100)}`);
        }
    }

    // ─── 5. Create Coupon Codes ────────────────────────────────────────
    console.log('\n5. Creating coupon codes...');
    const coupons = ['TEST-FREE-001', 'TEST-FREE-002', 'TEST-FREE-003'];
    for (const code of coupons) {
        const couponId = `COUPON-TEST-${code}`;
        try {
            const existing = await queryClient`SELECT id FROM coupon_codes WHERE code = ${code} LIMIT 1`;
            if (existing.length === 0) {
                await queryClient`
                    INSERT INTO coupon_codes (id, code, dealer_id, status, credits_available, discount_type, discount_value, created_at)
                    VALUES (${couponId}, ${code}, ${actualDealerAccountId}, 'available', 1, 'flat', 0, ${NOW_ISO})
                `;
                console.log(`  [created] Coupon: ${code}`);
            } else {
                console.log(`  [exists] Coupon: ${code}`);
            }
        } catch (e: any) {
            console.log(`  [skipped] Coupon: ${code} - ${e.message?.slice(0, 80)}`);
        }
    }

    // ─── 6. Create Dealer Onboarding Application ───────────────────────
    console.log('\n6. Creating dealer onboarding application...');
    try {
        const existingApp = await db.select().from(schema.dealerOnboardingApplications)
            .where(eq(schema.dealerOnboardingApplications.id, ONBOARDING_APP_ID)).limit(1);

        if (existingApp.length === 0) {
            await db.insert(schema.dealerOnboardingApplications).values({
                id: ONBOARDING_APP_ID,
                dealerUserId: dealerUserId,
                companyName: 'Sharma EV Motors Pvt Ltd',
                companyType: 'sole_proprietorship',
                gstNumber: '27AABCS1234Z1Z5',
                panNumber: 'ABCDE1234F',
                cinNumber: null,
                businessAddress: { address: 'Shop No 12, EV Market, Nashik, Maharashtra 422001' },
                financeEnabled: true,
                onboardingStatus: 'submitted',
                reviewStatus: 'pending_admin_review',
                submittedAt: NOW,
                ownerName: 'Rahul Sharma',
                ownerPhone: '9876543210',
                ownerEmail: 'test-dealer@itarang.com',
                bankName: 'State Bank of India',
                accountNumber: '12345678901234',
                beneficiaryName: 'Rahul Sharma',
                ifscCode: 'SBIN0001234',
                createdAt: NOW,
                updatedAt: NOW,
            });
            console.log(`  [created] Onboarding app: ${ONBOARDING_APP_ID}`);
        } else {
            console.log(`  [exists] Onboarding app`);
        }
    } catch (e: any) {
        console.log(`  [error] Onboarding app: ${e.message?.slice(0, 100)}`);
    }

    // ─── Done ──────────────────────────────────────────────────────────
    console.log('\n==========================================');
    console.log('  TEST DATA CREATED SUCCESSFULLY!');
    console.log('==========================================');
    console.log('\n  Login Credentials:');
    console.log('  ─────────────────────────────────────');
    console.log(`  Dealer:     test-dealer@itarang.com / ${PASSWORD}`);
    console.log(`  Admin:      test-admin@itarang.com  / ${PASSWORD}`);
    console.log(`  Sales Head: test-sh@itarang.com     / ${PASSWORD}`);
    console.log('');
    console.log('  Test Leads (visible under dealer login):');
    console.log('  ─────────────────────────────────────');
    console.log(`  HOT  (finance) : ${LEAD_HOT_ID}  → Vijay Kumar  → can access KYC`);
    console.log(`  WARM (finance) : ${LEAD_WARM_ID}  → Priya Patel  → can access KYC`);
    console.log(`  COLD (cash)    : ${LEAD_COLD_ID}  → Amit Singh   → no KYC needed`);
    console.log(`  HOT  (KYC done): ${LEAD_KYC_ID}  → Deepak Verma → docs uploaded, consent verified`);
    console.log('');
    console.log('  Coupon Codes: TEST-FREE-001, TEST-FREE-002, TEST-FREE-003');
    console.log('');
    console.log(`  Dealer Onboarding App ID: ${ONBOARDING_APP_ID}`);
    console.log(`    → Login as admin/sales_head and go to /admin/dealer-verification`);
    console.log('');
    console.log('  Test Flow:');
    console.log('  1. Login as test-dealer@itarang.com → Dashboard → Lead Management');
    console.log('  2. Click on Vijay Kumar → Lead Detail → Proceed to KYC');
    console.log('  3. Upload docs, send consent, validate coupon');
    console.log('  4. Login as test-admin@itarang.com → KYC Review → review docs');
    console.log('  5. Go to Dealer Validation → review & initiate agreement');
    console.log('');

    await queryClient.end();
    process.exit(0);
}

main().catch(err => {
    console.error('\nSeed failed:', err);
    queryClient.end().then(() => process.exit(1));
});
