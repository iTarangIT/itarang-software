/**
 * Seeds the two logins needed to test the Battery Buyback portal, plus the dealer
 * COMPANY the dealer login belongs to.
 *
 *   buyback.dealer@itarang.com  / password   role: dealer  →  /dealer-portal/buyback
 *   buyback.admin@itarang.com   / password   role: admin   →  /admin/buyback
 *
 * WHY A SCRIPT AND NOT A SIGN-UP FORM: a working login in this app is THREE things
 * that live in two different databases, and all three must agree.
 *
 *   1. A Supabase Auth user            — this is what the password is checked against
 *   2. A `users` row on AWS RDS        — this is where the app reads role + dealer_id
 *   3. An `accounts` row on AWS RDS    — the dealer COMPANY that owns the requests
 *
 * Miss (2) and you log in successfully and are then told your account is inactive.
 * Miss (3), or leave users.dealer_id null, and a dealer logs in fine and then cannot
 * create a request at all — every buyback route calls requireDealer(), which refuses
 * a dealer login that is not linked to a company. That is the failure people lose an
 * afternoon to, so this script does all three.
 *
 * The company is also given an ACTIVE BATTERY_DEALER role, which is what Sprint 4's
 * agreement gate will check.
 *
 * Idempotent — re-running resets the passwords and refreshes the rows.
 *
 * Usage:  node scripts/seed-buyback-test-users.js
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   DATABASE_URL                 (the AWS RDS connection string)
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { createClient } = require('@supabase/supabase-js');
const postgres = require('postgres');
require('dotenv').config({ path: '.env.local' });

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
);

const sql = postgres(process.env.DATABASE_URL, {
    ssl: { rejectUnauthorized: false },
    max: 1,
});

/**
 * The dealer COMPANY. The dealer login below belongs to this.
 *
 * `accounts.gstin` is UNIQUE, so this must not be a plausible real GSTIN — a
 * pretty one like 27AAAAA0000A1Z5 is exactly what someone else's fixture will
 * also have picked, and then this script dies on a constraint violation that
 * says nothing about why. BBTEST is deliberately un-guessable-into.
 */
const DEALER_COMPANY = {
    id: 'BBTEST-DEALER-1',
    name: 'Shakti Battery House (Test)',
    gstin: '27BBTEST0001Z1Z',
    pan: 'BBTEST0001',
    city: 'Nashik',
    state: 'Maharashtra',
    email: 'buyback.dealer@itarang.com',
    phone: '9820000001',
};

const USERS = [
    {
        email: 'buyback.dealer@itarang.com',
        password: 'password',
        name: 'Test Dealer',
        role: 'dealer',
        dealer_id: DEALER_COMPANY.id, // ← without this the dealer can log in but do nothing
        lands_on: '/dealer-portal/buyback',
    },
    {
        email: 'buyback.admin@itarang.com',
        password: 'password',
        name: 'Test Buyback Admin',
        role: 'admin',
        dealer_id: null,
        lands_on: '/admin/buyback',
    },
];

async function seedAuthUser(user) {
    const { data, error } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    if (error) throw new Error(`could not list auth users: ${error.message}`);

    const existing = data.users.find((a) => a.email === user.email);

    if (existing) {
        const { error: updateErr } = await supabase.auth.admin.updateUserById(existing.id, {
            password: user.password,
            app_metadata: { ...(existing.app_metadata || {}), role: user.role },
        });
        if (updateErr) throw new Error(`could not update ${user.email}: ${updateErr.message}`);
        console.log(`  ${user.email.padEnd(30)} auth user existed — password reset`);
        return existing.id;
    }

    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
        email: user.email,
        password: user.password,
        email_confirm: true,
        app_metadata: { role: user.role },
    });
    if (createErr) throw new Error(`could not create ${user.email}: ${createErr.message}`);
    console.log(`  ${user.email.padEnd(30)} auth user created`);
    return created.user.id;
}

async function run() {
    for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL']) {
        if (!process.env[key]) {
            console.error(`${key} is not set in .env.local`);
            process.exit(1);
        }
    }

    const host = process.env.DATABASE_URL.split('@')[1]?.split('/')[0];
    console.log(`\nSeeding buyback test logins against ${host}\n`);

    // `accounts.gstin` is UNIQUE. If some OTHER account already holds ours, the
    // INSERT below dies with a raw "duplicate key ... accounts_gstin_key", which
    // tells the reader nothing. Say what actually happened instead.
    const clash = await sql`
        SELECT id, business_entity_name FROM accounts
        WHERE gstin = ${DEALER_COMPANY.gstin} AND id <> ${DEALER_COMPANY.id}
    `;
    if (clash.length > 0) {
        console.error(
            `\nGSTIN ${DEALER_COMPANY.gstin} is already used by a DIFFERENT account:\n` +
            `  ${clash[0].id} — ${clash[0].business_entity_name}\n\n` +
            `accounts.gstin is UNIQUE, so this script cannot create its test company.\n` +
            `Either delete that account, or change DEALER_COMPANY.gstin at the top of\n` +
            `this file to something else.\n`,
        );
        await sql.end();
        process.exit(1);
    }

    // 1. The dealer COMPANY. Requests belong to a company, not to a person.
    await sql`
        INSERT INTO accounts (id, business_entity_name, gstin, pan, contact_name,
                              contact_email, contact_phone, city, state,
                              status, onboarding_status, created_at, updated_at)
        VALUES (${DEALER_COMPANY.id}, ${DEALER_COMPANY.name}, ${DEALER_COMPANY.gstin},
                ${DEALER_COMPANY.pan}, 'Test Dealer', ${DEALER_COMPANY.email},
                ${DEALER_COMPANY.phone}, ${DEALER_COMPANY.city}, ${DEALER_COMPANY.state},
                'active', 'approved', NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET
            business_entity_name = EXCLUDED.business_entity_name,
            contact_email        = EXCLUDED.contact_email,
            contact_phone        = EXCLUDED.contact_phone,
            status               = 'active',
            updated_at           = NOW()
    `;
    console.log(`  dealer company ready: ${DEALER_COMPANY.name} (${DEALER_COMPANY.id})`);

    // The buyback role on that company. Harmless now; Sprint 4's agreement gate
    // checks exactly this.
    await sql`
        INSERT INTO business_entity_roles (entity_id, role, status)
        VALUES (${DEALER_COMPANY.id}, 'BATTERY_DEALER', 'ACTIVE')
        ON CONFLICT (entity_id, role) DO UPDATE SET status = 'ACTIVE', updated_at = NOW()
    `;
    console.log('  BATTERY_DEALER role active\n');

    // 2. The logins.
    for (const user of USERS) {
        const authId = await seedAuthUser(user);

        await sql`
            INSERT INTO users (id, email, name, role, dealer_id, is_active,
                               must_change_password, created_at, updated_at)
            VALUES (${authId}::uuid, ${user.email}, ${user.name}, ${user.role},
                    ${user.dealer_id}, true, false, NOW(), NOW())
            ON CONFLICT (id) DO UPDATE SET
                email                = EXCLUDED.email,
                name                 = EXCLUDED.name,
                role                 = EXCLUDED.role,
                dealer_id            = EXCLUDED.dealer_id,
                is_active            = true,
                must_change_password = false,
                updated_at           = NOW()
        `;

        // A legacy row with the same email but a different id would win the
        // email-fallback lookup in auth-utils and silently override the role.
        await sql`
            UPDATE users
            SET role = ${user.role}, dealer_id = ${user.dealer_id},
                is_active = true, must_change_password = false, updated_at = NOW()
            WHERE email = ${user.email} AND id <> ${authId}::uuid
        `;

        const { error: loginErr } = await supabase.auth.signInWithPassword({
            email: user.email,
            password: user.password,
        });
        if (loginErr) throw new Error(`login test failed for ${user.email}: ${loginErr.message}`);
        console.log(`  ${user.email.padEnd(30)} RDS row ready · login verified`);
    }

    // 3. The catalogue. Intake has nothing to choose from without it.
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM catalog_variants WHERE active`;
    if (n === 0) {
        console.log('\n  ⚠  The battery catalogue is EMPTY. The dealer intake page will have');
        console.log('     nothing to select. Run:  npx tsx --env-file=.env.local scripts/seed-buyback-catalog.ts');
    } else {
        console.log(`\n  catalogue: ${n} active battery types`);
    }

    console.log('\n────────────────────────────────────────────────────────────');
    for (const u of USERS) {
        console.log(`  ${u.email}  /  ${u.password}`);
        console.log(`      role: ${u.role.padEnd(8)} →  ${u.lands_on}`);
    }
    console.log('────────────────────────────────────────────────────────────');
    console.log('\n  Log the ADMIN in in a normal window, and the DEALER in a');
    console.log('  private/incognito window — otherwise they log each other out.\n');

    await sql.end();
    process.exit(0);
}

run().catch(async (err) => {
    console.error('\nFailed:', err.message);
    try { await sql.end(); } catch { /* already closed */ }
    process.exit(1);
});
