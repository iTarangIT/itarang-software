// ID 225 — read-only: the logins scripts/seed-test-data.ts creates (one shared
// password, now taken from SEED_TEST_PASSWORD) and any other test-looking
// @itarang.com login, with whether each can still sign in. Changes nothing and
// never tries a password.
//
//   node --import tsx --env-file=.env.local scripts/list-seeded-test-logins.ts        # sandbox
//   node --import tsx --env-file=.env.production scripts/list-seeded-test-logins.ts   # live (you run it)
//
// "can sign in" = users.is_active is true AND the auth user exists and is not banned.
// On live every row should read "no". Deactivate a "yes" in Admin › Users (ID 219).

import { createClient } from "@supabase/supabase-js";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

const SEEDED = ["test-dealer@itarang.com", "test-admin@itarang.com", "test-sh@itarang.com"];

type Row = { id: string; email: string; role: string; is_active: boolean; created_at: string | null };

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    console.log(`DB host: ${host || "(unset)"}\n`);

    const rows = (await db.execute(sql`
        SELECT id::text, email, role, is_active, created_at::text
          FROM users
         WHERE lower(email) IN ${SEEDED}
            OR lower(email) LIKE 'test-%@itarang.com'
            OR lower(email) LIKE 'test.%@itarang.com'
            OR lower(email) LIKE 'e2e%@itarang.com'
         ORDER BY email
    `)) as unknown as Row[];

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const auth = url && key ? createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }) : null;

    const found = new Set(rows.map((r) => r.email.toLowerCase()));
    for (const e of SEEDED) if (!found.has(e)) console.log(`${e.padEnd(34)} not in users (seed never ran here)`);

    let open = 0;
    for (const r of rows) {
        let authState = "auth: not checked";
        let authOk = true;
        if (auth) {
            const { data, error } = await auth.auth.admin.getUserById(r.id);
            if (error || !data?.user) {
                authState = "auth: no auth user";
                authOk = false;
            } else {
                const banned = data.user.banned_until && new Date(data.user.banned_until) > new Date();
                authState = banned ? `auth: banned until ${data.user.banned_until}` : "auth: active";
                authOk = !banned;
            }
        }
        const canSignIn = r.is_active && authOk;
        if (canSignIn) open++;
        console.log(
            `${r.email.padEnd(34)} ${r.role.padEnd(18)} is_active=${String(r.is_active).padEnd(5)} ${authState.padEnd(28)} can sign in: ${canSignIn ? "YES" : "no"}`,
        );
    }
    console.log(`\n${rows.length} test-looking login(s); ${open} can still sign in.`);
    process.exit(0);
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
