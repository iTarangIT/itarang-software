/**
 * Seeds the three named ASM (Area Sales Manager) user accounts.
 *
 *   anupam@itarang.com    / password  / role: asm
 *   sonu@itarang.com      / password  / role: asm
 *   abhishek@itarang.com  / password  / role: asm
 *
 * Writes to BOTH:
 *   - Supabase Auth (signInWithPassword reads from here)
 *   - public.users on the AWS RDS Postgres (web app's auth-utils
 *     queries this via Drizzle; missing row → "account is inactive")
 *
 * The `asm` role already routes to /asm in src/middleware.ts — no route
 * config needed. Idempotent: re-running resets each password, refreshes
 * app_metadata, and updates the AWS RDS users row.
 *
 * Usage: node scripts/seed-asm-users.js
 * Requires (.env.local):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   DATABASE_URL                     (AWS RDS connection string)
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { createClient } = require('@supabase/supabase-js');
const postgres = require('postgres');
require('dotenv').config({ path: '.env.local' });

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
);

const sql = postgres(process.env.DATABASE_URL, {
    ssl: { rejectUnauthorized: false },
    max: 1,
});

const USERS = [
    { email: 'anupam@itarang.com',   password: 'password', name: 'Anupam',   role: 'asm' },
    { email: 'sonu@itarang.com',     password: 'password', name: 'Sonu',     role: 'asm' },
    { email: 'abhishek@itarang.com', password: 'password', name: 'Abhishek', role: 'asm' },
];

async function seedUser(user, authUsers) {
    console.log(`\nSeeding asm user: ${user.email}`);

    // 1. Supabase Auth — create or update the auth user.
    let authId;
    const existing = authUsers.find(a => a.email === user.email);

    if (existing) {
        authId = existing.id;
        const { error: updateErr } = await supabase.auth.admin.updateUserById(authId, {
            password: user.password,
            app_metadata: { ...(existing.app_metadata || {}), role: user.role },
        });
        if (updateErr) {
            console.error(`  Failed to update auth user ${user.email}:`, updateErr.message);
            return false;
        }
        console.log(`  auth user existed — password + app_metadata.role refreshed (id: ${authId})`);
    } else {
        const { data: created, error: createErr } = await supabase.auth.admin.createUser({
            email: user.email,
            password: user.password,
            email_confirm: true,
            app_metadata: { role: user.role },
        });
        if (createErr) {
            console.error(`  Failed to create auth user ${user.email}:`, createErr.message);
            return false;
        }
        authId = created.user.id;
        console.log(`  auth user created (id: ${authId})`);
    }

    // 2. AWS RDS — upsert the users row by id, then reconcile any same-email /
    //    different-id legacy row (auth-utils looks up by id, then by email).
    await sql`
        INSERT INTO users (id, email, name, role, is_active, must_change_password, created_at, updated_at)
        VALUES (${authId}::uuid, ${user.email}, ${user.name}, ${user.role}, true, false, NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET
            email = EXCLUDED.email,
            name = EXCLUDED.name,
            role = EXCLUDED.role,
            is_active = true,
            must_change_password = false,
            updated_at = NOW()
    `;
    await sql`
        UPDATE users
        SET role = ${user.role}, is_active = true, must_change_password = false, updated_at = NOW()
        WHERE email = ${user.email} AND id <> ${authId}::uuid
    `;
    console.log('  AWS RDS users row ready');

    // 3. Verify Supabase login still works.
    const { error: loginErr } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: user.password,
    });
    if (loginErr) {
        console.error(`  Login test failed for ${user.email}:`, loginErr.message);
        return false;
    }
    console.log('  login verified');
    return true;
}

async function run() {
    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL is not set in .env.local');
        process.exit(1);
    }

    const { data: { users: authUsers }, error: listErr } =
        await supabase.auth.admin.listUsers({ perPage: 1000 });
    if (listErr) {
        console.error('Could not list auth users:', listErr.message);
        process.exit(1);
    }

    let ok = true;
    for (const user of USERS) {
        const result = await seedUser(user, authUsers);
        ok = ok && result;
    }

    console.log('\n──────────────────────────────────────────');
    for (const u of USERS) {
        console.log(`  ${u.email}  /  ${u.password}  →  /asm`);
    }
    console.log('──────────────────────────────────────────\n');

    await sql.end();
    process.exit(ok ? 0 : 1);
}

run().catch(async err => {
    console.error('Fatal:', err);
    try { await sql.end(); } catch {}
    process.exit(1);
});
