/**
 * Seeds the Feature Request & Approval module (E-316): four new logins plus
 * the seat table that decides who can do what.
 *
 *   kartik@itarangjosh.com     product_head  → product_reviewer
 *   apoorv@itarangjosh.com     tech_head     → tech_reviewer
 *   aditya@itarangjosh.com     developer     → developer
 *   rushikesh@itarangjosh.com  developer     → developer
 *   every active role=ceo user   ceo (untouched) → requester
 *
 * Password (ID 140): a NEW login gets FR_SEED_PASSWORD, or a random one that is
 * printed once, and must change it at first sign-in. An EXISTING login is never
 * touched — not its password, not its role — it only gets its seat. Re-running
 * this script can therefore never reset anyone's password. The CEO accounts
 * likewise only get their seat.
 *
 * Writes to BOTH Supabase Auth (login) and public.users on the AWS RDS
 * Postgres in DATABASE_URL (auth-utils reads that; a missing row reads as
 * "account is inactive"). Idempotent.
 *
 * Usage:
 *   node scripts/seed-feature-request-users.js
 *   node --env-file=.env.production scripts/seed-feature-request-users.js   (prod)
 * Requires (.env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * DATABASE_URL. Needs E-316 applied to that database first.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const crypto = require('crypto');
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

// Never a fixed, guessable default (ID 140) — every run without FR_SEED_PASSWORD
// draws a fresh random one for the logins it creates.
const NEW_LOGIN_PASSWORD = process.env.FR_SEED_PASSWORD || crypto.randomBytes(12).toString('base64url');
const USERS = [
    { email: 'kartik@itarangjosh.com', name: 'Kartik', role: 'product_head', seat: 'product_reviewer' },
    { email: 'apoorv@itarangjosh.com', name: 'Apoorv', role: 'tech_head', seat: 'tech_reviewer' },
    { email: 'aditya@itarangjosh.com', name: 'Aditya', role: 'developer', seat: 'developer' },
    { email: 'rushikesh@itarangjosh.com', name: 'Rushikesh', role: 'developer', seat: 'developer' },
];


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
        // ID 140: an existing login keeps its password and role — a re-run must
        // never put a known password back on a live account.
        authId = existing.id;
        console.log(`  ${u.email}: auth user exists — password and role left as they are`);
    } else {
        const { data, error } = await supabase.auth.admin.createUser({
            email: u.email,
            password: NEW_LOGIN_PASSWORD,
            email_confirm: true,
            app_metadata: { role: u.role },
        });
        if (error) throw new Error(`create ${u.email}: ${error.message}`);
        authId = data.user.id;
        created.push(u.email);
        console.log(`  ${u.email}: auth user created`);
    }

    // Missing row only: an existing users row (role, active flag, password
    // state) is the owner's, not this script's.
    await sql`
        INSERT INTO users (id, email, name, role, is_active, must_change_password, created_at, updated_at)
        VALUES (${authId}::uuid, ${u.email}, ${u.name}, ${u.role}, true, true, NOW(), NOW())
        ON CONFLICT (id) DO NOTHING
    `;
    await upsertSeat(authId, u.seat);
    console.log(`  ${u.email}: RDS row + seat ${u.seat} ready`);
}

const created = [];

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
    if (created.length > 0) {
        console.log(
            `\nNew login(s) ${created.join(', ')} — first-time password ` +
                `${process.env.FR_SEED_PASSWORD ? '(FR_SEED_PASSWORD)' : NEW_LOGIN_PASSWORD}; ` +
                'each must change it at first sign-in. Shown once, not stored.\n',
        );
    }

    // Every active CEO login (Sanchit + the CEO test account) can raise
    // requests: seat only — their password and role stay as they are.
    const ceos = await sql`SELECT id, email, name FROM users WHERE lower(role) = 'ceo' AND is_active = true`;
    if (ceos.length === 0) throw new Error('No active users with role "ceo" on this database');
    for (const c of ceos) {
        await upsertSeat(c.id, 'requester');
        console.log(`  ${c.email} (${c.name}): seat requester ready`);
    }

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
