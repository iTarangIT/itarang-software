/**
 * One-off: put the `monitor` users row on PRODUCTION (database-2).
 *
 * The normal seeder (scripts/create-monitor-user.ts) reads .env.local, which
 * points at database-1. .env.production carries only DATABASE_URL and no
 * Supabase keys, and this repo's _load-env plus Windows' case-insensitive
 * process.env make env precedence too subtle to bet a production write on. So
 * this script parses each file EXPLICITLY, names the host it is about to write
 * to, and refuses to run if that host is not database-2.
 *
 * The Supabase Auth user already exists (created when the sandbox row was
 * seeded) and auth is a single project across both environments, so only the
 * RDS row is missing. Idempotent: re-running updates rather than duplicating.
 *
 *   node scripts/_seed-monitor-user-prod.mjs
 */
import fs from "node:fs";
import postgres from "postgres";
import bcrypt from "bcryptjs";
import { createClient } from "@supabase/supabase-js";

const EMAIL = "monitor@itarang.com";
const PASSWORD = "password";
const NAME = "Fleet Monitor";
const ROLE = "monitor";

function readEnvFile(path) {
    const out = {};
    if (!fs.existsSync(path)) return out;
    for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return out;
}

const prod = readEnvFile(".env.production");
const local = readEnvFile(".env.local");

const DB = prod.DATABASE_URL;
if (!DB) throw new Error(".env.production has no DATABASE_URL");

const host = new URL(DB).hostname;
console.log("target database :", host);
if (!host.includes("database-2")) {
    throw new Error(`refusing to run: expected database-2 (production), got ${host}`);
}

const SUPA_URL = local.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = local.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) throw new Error("Supabase URL / service role key not found in .env.local");
console.log("supabase project:", SUPA_URL);

const admin = createClient(SUPA_URL, SUPA_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
});

// Find the existing auth user rather than hardcoding its id.
const { data: list, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 });
if (listErr) throw listErr;
const authUser = list?.users?.find((u) => u.email?.toLowerCase() === EMAIL);
if (!authUser) {
    throw new Error(`no Supabase auth user for ${EMAIL} — run "npm run seed:monitor-user" first`);
}
console.log("auth user id    :", authUser.id);

const sql = postgres(DB, { ssl: { rejectUnauthorized: false }, prepare: false, max: 1, connect_timeout: 15 });

try {
    const password_hash = await bcrypt.hash(PASSWORD, 10);

    const before = await sql`
        SELECT id, email, role, is_active FROM users
        WHERE id = ${authUser.id}::uuid OR lower(email) = ${EMAIL}
    `;
    console.log("existing rows   :", before.length ? JSON.stringify(before) : "none");

    // Repoint any email-matched row onto the auth id first — auth-utils looks up
    // by id before email, so a row under a stale id would shadow this one.
    await sql`
        UPDATE users SET id = ${authUser.id}::uuid, updated_at = now()
        WHERE lower(email) = ${EMAIL} AND id <> ${authUser.id}::uuid
    `;

    await sql`
        INSERT INTO users (id, email, name, role, is_active, must_change_password, password_hash, created_at, updated_at)
        VALUES (${authUser.id}::uuid, ${EMAIL}, ${NAME}, ${ROLE}, true, false, ${password_hash}, now(), now())
        ON CONFLICT (id) DO UPDATE SET
            email = EXCLUDED.email,
            name = EXCLUDED.name,
            role = EXCLUDED.role,
            is_active = true,
            must_change_password = false,
            password_hash = EXCLUDED.password_hash,
            updated_at = now()
    `;

    const after = await sql`
        SELECT id, email, name, role, is_active FROM users WHERE id = ${authUser.id}::uuid
    `;
    console.log("after           :", JSON.stringify(after));
    console.log("\nPROD monitor login ready — https://crm.itarang.com/login -> /monitor");
} finally {
    await sql.end({ timeout: 5 });
}
