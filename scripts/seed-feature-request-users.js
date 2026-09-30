/**
 * Seeds the Feature Request & Approval module (E-316): four new logins plus
 * the seat table that decides who can do what.
 *
 *   kartik@itarangjosh.com     product_head  → product_reviewer
 *   apoorv@itarangjosh.com     tech_head     → tech_reviewer
 *   aditya@itarangjosh.com     developer     → developer
 *   rushikesh@itarangjosh.com  developer     → developer
 *   <CEO account>              ceo (untouched) → requester
 *
 * Password for the four new logins: "password". The CEO account's password
 * and role are NOT touched — it only gets its seat.
 *
 * Writes to BOTH Supabase Auth (login) and public.users on the AWS RDS
 * Postgres in DATABASE_URL (auth-utils reads that; a missing row reads as
 * "account is inactive"). Idempotent.
 *
 * Usage:
 *   node scripts/seed-feature-request-users.js [--ceo-email ceo@itarang.com]
 * Requires (.env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * DATABASE_URL. Needs E-316 applied to that database first.
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

const PASSWORD = 'password';
const USERS = [
    { email: 'kartik@itarangjosh.com', name: 'Kartik', role: 'product_head', seat: 'product_reviewer' },
    { email: 'apoorv@itarangjosh.com', name: 'Apoorv', role: 'tech_head', seat: 'tech_reviewer' },
    { email: 'aditya@itarangjosh.com', name: 'Aditya', role: 'developer', seat: 'developer' },
    { email: 'rushikesh@itarangjosh.com', name: 'Rushikesh', role: 'developer', seat: 'developer' },
];

const argIdx = process.argv.indexOf('--ceo-email');
const CEO_EMAIL = (argIdx > -1 ? process.argv[argIdx + 1] : 'ceo@itarang.com').toLowerCase();

async function findAuthUser(email) {
    for (let page = 1; page < 50; page++) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw new Error(`Could not list auth users: ${error.message}`);
        const hit = data.users.find(a => (a.email || '').toLowerCase() === email);
        if (hit) return hit;
        if (data.users.length < 1000) return null;
    }
    return null;
}

async function seedUser(u) {
    const existing = await findAuthUser(u.email);
    let authId;
    if (existing) {
        authId = existing.id;
        const { error } = await supabase.auth.admin.updateUserById(authId, {
            password: PASSWORD,
            app_metadata: { ...(existing.app_metadata || {}), role: u.role },
        });
        if (error) throw new Error(`update ${u.email}: ${error.message}`);
        console.log(`  ${u.email}: auth user existed — password + role refreshed`);
    } else {
        const { data, error } = await supabase.auth.admin.createUser({
            email: u.email,
            password: PASSWORD,
            email_confirm: true,
            app_metadata: { role: u.role },
        });
        if (error) throw new Error(`create ${u.email}: ${error.message}`);
        authId = data.user.id;
        console.log(`  ${u.email}: auth user created`);
    }

    await sql`
        INSERT INTO users (id, email, name, role, is_active, must_change_password, created_at, updated_at)
        VALUES (${authId}::uuid, ${u.email}, ${u.name}, ${u.role}, true, false, NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET
            email = EXCLUDED.email, name = EXCLUDED.name, role = EXCLUDED.role,
            is_active = true, must_change_password = false, updated_at = NOW()
    `;
    await sql`
        UPDATE users SET role = ${u.role}, is_active = true, must_change_password = false, updated_at = NOW()
        WHERE email = ${u.email} AND id <> ${authId}::uuid
    `;
    await upsertSeat(authId, u.seat);

    const { error: loginErr } = await supabase.auth.signInWithPassword({ email: u.email, password: PASSWORD });
    if (loginErr) throw new Error(`login test ${u.email}: ${loginErr.message}`);
    console.log(`  ${u.email}: RDS row + seat ${u.seat} ready, login verified`);
}

async function upsertSeat(userId, seat) {
    await sql`
        INSERT INTO feature_request_members (user_id, seat, is_active, created_at, updated_at)
        VALUES (${userId}::uuid, ${seat}, true, NOW(), NOW())
        ON CONFLICT (user_id) DO UPDATE SET seat = EXCLUDED.seat, is_active = true, updated_at = NOW()
    `;
}

async function run() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set in .env.local');
    console.log(`Target DB: ${new URL(process.env.DATABASE_URL).host}`);

    const [reg] = await sql`SELECT to_regclass('feature_request_members') AS t`;
    if (!reg.t) throw new Error('E-316 is not applied to this database — run scripts/_apply-e316.mjs first');

    for (const u of USERS) await seedUser(u);

    // The CEO: seat only. Their password and role stay as they are.
    const ceo = await sql`SELECT id, name, role FROM users WHERE lower(email) = ${CEO_EMAIL} LIMIT 1`;
    if (!ceo[0]) throw new Error(`No users row for CEO ${CEO_EMAIL} — pass --ceo-email`);
    if (ceo[0].role !== 'ceo') console.warn(`  ! ${CEO_EMAIL} has role "${ceo[0].role}", not "ceo"`);
    await upsertSeat(ceo[0].id, 'requester');
    console.log(`  ${CEO_EMAIL} (${ceo[0].name}): seat requester ready`);

    console.table(await sql`
        SELECT u.email, u.name, u.role, m.seat, m.is_active
          FROM feature_request_members m JOIN users u ON u.id = m.user_id
         ORDER BY m.seat, u.email
    `);
}

run()
    .then(async () => {
        await sql.end();
        process.exit(0);
    })
    .catch(async err => {
        console.error('Fatal:', err.message || err);
        try { await sql.end(); } catch {}
        process.exit(1);
    });
