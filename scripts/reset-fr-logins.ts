// ID 140 — close the Feature Request logins that still accept the old fixed
// password "password".
//
//   node --import tsx --env-file=.env.production scripts/reset-fr-logins.ts --out <file>           (dry run)
//   node --import tsx --env-file=.env.production scripts/reset-fr-logins.ts --out <file> --apply
//
// For each of the four logins it first TRIES "password" (anon key). Only the
// ones that still sign in with it are touched; the others are left exactly as
// they are. With --apply, each open login gets:
//   * a new random password (Supabase Auth, service role), and
//   * must_change_password = true on its users row (RDS), so the first sign-in
//     must choose a new one (middleware → /change-password).
// Then it checks: "password" is refused and the new password signs in.
//
// The new passwords are written ONLY to --out (never printed), to hand to each
// person privately. Delete the file once they have them.

import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { sql } from "drizzle-orm";

const EMAILS = [
    "kartik@itarangjosh.com",
    "apoorv@itarangjosh.com",
    "aditya@itarangjosh.com",
    "rushikesh@itarangjosh.com",
];

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function signsIn(url: string, anon: string, email: string, password: string): Promise<boolean> {
    const sb = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (!error) {
        await sb.auth.signOut();
        return true;
    }
    if (/invalid login credentials/i.test(error.message)) return false;
    throw new Error(`${email}: ${error.message}`);
}

async function main() {
    const apply = process.argv.includes("--apply");
    const out = arg("--out");
    if (!out) throw new Error("--out <file> is required (the new passwords go there, never to the terminal)");
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !anon || !service) {
        throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY not set");
    }
    const { db } = await import("@/lib/db");
    console.log(`Auth project: ${new URL(url).host}`);
    console.log(`DB host:      ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}`);
    console.log(apply ? "Mode: APPLY\n" : "Mode: dry run (add --apply to reset)\n");

    const open: string[] = [];
    for (const email of EMAILS) {
        const isOpen = await signsIn(url, anon, email, "password");
        console.log(`${isOpen ? "OPEN  " : "CLOSED"}  ${email}`);
        if (isOpen) open.push(email);
    }
    if (open.length === 0) {
        console.log("\nNothing to do — no login accepts \"password\".");
        process.exit(0);
    }
    if (!apply) {
        console.log(`\n${open.length} login(s) would be reset.`);
        process.exit(0);
    }

    const admin = createClient(url, service, { auth: { autoRefreshToken: false, persistSession: false } });
    const ids = new Map<string, string>();
    for (let page = 1; ids.size < open.length; page++) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw error;
        for (const u of data.users) {
            const e = u.email?.toLowerCase();
            if (e && open.includes(e)) ids.set(e, u.id);
        }
        if (data.users.length < 1000) break;
    }

    const issued: string[] = [];
    let failed = 0;
    for (const email of open) {
        const id = ids.get(email);
        if (!id) {
            failed++;
            console.log(`FAIL  ${email} — signs in but was not found by the admin API`);
            continue;
        }
        const password = randomBytes(12).toString("base64url");
        const { error } = await admin.auth.admin.updateUserById(id, { password });
        if (error) {
            failed++;
            console.log(`FAIL  ${email} — ${error.message}`);
            continue;
        }
        const rows = (await db.execute(sql`
            UPDATE users SET must_change_password = TRUE, updated_at = now()
             WHERE lower(email) = ${email}
            RETURNING id
        `)) as unknown as unknown[];
        issued.push(`${email}\t${password}`);

        const oldRefused = !(await signsIn(url, anon, email, "password"));
        const newWorks = await signsIn(url, anon, email, password);
        const ok = oldRefused && newWorks;
        if (!ok) failed++;
        console.log(
            `${ok ? "DONE " : "FAIL "} ${email} — "password" ${oldRefused ? "refused" : "STILL WORKS"}, ` +
                `new password ${newWorks ? "works" : "DOES NOT WORK"}, users rows flagged: ${rows.length}`,
        );
    }

    if (issued.length > 0) {
        writeFileSync(
            out,
            "# New Feature Request passwords (ID 140). Hand each to its owner privately, then delete this file.\n" +
                "# Each login must choose its own password at first sign-in.\n" +
                issued.join("\n") +
                "\n",
            { mode: 0o600 },
        );
        console.log(`\nNew passwords written to ${out} (not printed).`);
    }
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
});
