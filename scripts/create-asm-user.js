/**
 * Creates (or resets) ONE ASM login by email — the generic form of
 * seed-asm-user.js, for ad-hoc sandbox testers.
 *
 * Writes to BOTH:
 *   - Supabase Auth (signInWithPassword reads from here)
 *   - public.users on the AWS RDS Postgres pointed at by DATABASE_URL
 *     (auth-utils queries this via Drizzle; missing row → "account is inactive")
 *
 * Idempotent — re-running resets the password, refreshes app_metadata.role,
 * and updates the RDS users row. The users row is matched by AUTH ID, not
 * email (Auth lowercases emails; users.email is mixed-case in places).
 *
 * Usage:
 *   node scripts/create-asm-user.js <email> [name] [password]
 *   node scripts/create-asm-user.js tester@example.com "Tester" password
 *
 * Requires (.env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { createClient } = require('@supabase/supabase-js');
const postgres = require('postgres');
require('dotenv').config({ path: '.env.local' });

const [, , emailArg, nameArg, passwordArg] = process.argv;
if (!emailArg || !emailArg.includes('@')) {
    console.error('Usage: node scripts/create-asm-user.js <email> [name] [password]');
    process.exit(1);
}

const USER = {
    email: emailArg.trim().toLowerCase(),
    password: passwordArg || 'password',
    name: nameArg || `ASM ${emailArg.split('@')[0]}`,
    role: 'asm',
};

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
);

const sql = postgres(process.env.DATABASE_URL, {
    ssl: { rejectUnauthorized: false },
    max: 1,
});

async function run() {
    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL is not set in .env.local');
        process.exit(1);
    }
    const host = process.env.DATABASE_URL.replace(/^.*@/, '').replace(/\/.*$/, '');
    console.log(`Seeding asm user: ${USER.email}  (RDS: ${host})`);

    const { data: { users: authUsers }, error: listErr } =
        await supabase.auth.admin.listUsers({ perPage: 1000 });
    if (listErr) {
        console.error('Could not list auth users:', listErr.message);
        process.exit(1);
    }

    let authId;
    const existing = authUsers.find(a => (a.email || '').toLowerCase() === USER.email);

    if (existing) {
        authId = existing.id;
        const { error: updateErr } = await supabase.auth.admin.updateUserById(authId, {
            password: USER.password,
            app_metadata: { ...(existing.app_metadata || {}), role: USER.role },
        });
        if (updateErr) {
            console.error('Failed to update auth user:', updateErr.message);
            process.exit(1);
        }
        console.log(`  auth user existed — password + app_metadata.role refreshed (id: ${authId})`);
    } else {
        const { data: created, error: createErr } = await supabase.auth.admin.createUser({
            email: USER.email,
            password: USER.password,
            email_confirm: true,
            app_metadata: { role: USER.role },
        });
        if (createErr) {
            console.error('Failed to create auth user:', createErr.message);
            process.exit(1);
        }
        authId = created.user.id;
        console.log(`  auth user created (id: ${authId})`);
    }

    await sql`
        INSERT INTO users (id, email, name, role, is_active, must_change_password, created_at, updated_at)
        VALUES (${authId}::uuid, ${USER.email}, ${USER.name}, ${USER.role}, true, false, NOW(), NOW())
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
        SET role = ${USER.role}, is_active = true, must_change_password = false, updated_at = NOW()
        WHERE lower(email) = ${USER.email} AND id <> ${authId}::uuid
    `;
    console.log('  RDS users row ready');

    const { error: loginErr } = await supabase.auth.signInWithPassword({
        email: USER.email,
        password: USER.password,
    });
    if (loginErr) {
        console.error('Login test failed:', loginErr.message);
        process.exit(1);
    }
    console.log('  login verified');

    console.log('\n──────────────────────────────────────────');
    console.log(`  ${USER.email}  /  ${USER.password}  →  /asm   (id: ${authId})`);
    console.log('──────────────────────────────────────────\n');

    await sql.end();
    process.exit(0);
}

run().catch(async err => {
    console.error('Fatal:', err);
    try { await sql.end(); } catch {}
    process.exit(1);
});
