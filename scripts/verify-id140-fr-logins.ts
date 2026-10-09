// Read-only check for ID 140: do the four Feature Request logins still accept
// the old fixed password "password"?
//
//   node --import tsx --env-file=.env.local scripts/verify-id140-fr-logins.ts        (sandbox)
//   node --import tsx --env-file=.env.production scripts/verify-id140-fr-logins.ts   (live)
//
// It only TRIES to sign in (anon key, no service role). A successful sign-in is
// signed straight back out; nothing is changed. Each login reports:
//   CLOSED  — "password" is refused (reset, or the account is disabled)
//   OPEN    — "password" still works: reset it (Supabase dashboard → Auth → user)
//   MISSING — no such login on this project

import { createClient } from "@supabase/supabase-js";

const EMAILS = [
    "kartik@itarangjosh.com",
    "apoorv@itarangjosh.com",
    "aditya@itarangjosh.com",
    "rushikesh@itarangjosh.com",
];

async function main() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anon) throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY not set");
    console.log(`Auth project: ${new URL(url).host}\n`);

    let open = 0;
    for (const email of EMAILS) {
        const sb = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });
        const { error } = await sb.auth.signInWithPassword({ email, password: "password" });
        if (!error) {
            open++;
            await sb.auth.signOut();
            console.log(`OPEN     ${email}  — still signs in with "password"`);
        } else if (/invalid login credentials/i.test(error.message)) {
            // Supabase answers a wrong password and an unknown email the same way.
            console.log(`CLOSED   ${email}  — "password" refused (or no such login)`);
        } else {
            console.log(`UNKNOWN  ${email}  — ${error.message}`);
        }
    }
    console.log(open ? `\n${open} login(s) still open — reset them.` : "\nAll closed.");
    process.exit(open ? 1 : 0);
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
});
