// ID 140 — park the Feature Request module and switch off the test logins.
//
//   node --import tsx --env-file=.env.local      scripts/disable-test-logins.ts            (dry run, sandbox)
//   node --import tsx --env-file=.env.production scripts/disable-test-logins.ts --apply    (prod)
//
// Decided 10 Oct: the 4 Feature Request logins and every login made by the old
// test-login setup tools (ASM, CEO, buyback, scraper) are disabled; the tools
// themselves are deleted from scripts/. The module's code stays, parked.
//
// For each login in DISABLE, with --apply:
//   * users.is_active = false (RDS)  — the sign-in page refuses it;
//   * a Supabase Auth ban            — an EXISTING session can no longer
//     refresh, because middleware does not re-check is_active;
// and every feature_request_members seat (CEO "requester" seats included) is
// switched off, so the module's API refuses everyone.
//
// Real colleagues those tools also created are only REPORTED (REPORT_ONLY):
// they are people, not test logins.
//
// Reversible: users.is_active = true, feature_request_members.is_active = true,
// and `auth.admin.updateUserById(id, { ban_duration: "none" })`.

import { createClient, type User } from "@supabase/supabase-js";
import { sql } from "drizzle-orm";

const DISABLE = [
    // Feature Request module (parked)
    "kartik@itarangjosh.com",
    "apoorv@itarangjosh.com",
    "aditya@itarangjosh.com",
    "rushikesh@itarangjosh.com",
    "fr-test-ceo@itarangjosh.com",
    // old test-login setup tools
    "asm.itarang@gmail.com",
    "ceo.itarang@gmail.com",
    "buyback.dealer@itarang.com",
    "buyback.admin@itarang.com",
    "sales.head@itarang.com",
    "sales.manager@itarang.com",
];

/** Made by the same tools, but these are real people's logins — left alone. */
const REPORT_ONLY = [
    "anupam@itarang.com",
    "sonu@itarang.com",
    "abhishek@itarang.com",
    "jiten@itarang.com",
    "ganesh@itarangjosh.com",
    "nidhi.itarang@gmail.com",
    "chirag.itarang@gmail.com",
];

const BAN = "876000h"; // ~100 years; "none" lifts it

type UserRow = { id: string; email: string; role: string | null; is_active: boolean | null };

async function authUsers(url: string, service: string, wanted: Set<string>) {
    const admin = createClient(url, service, { auth: { autoRefreshToken: false, persistSession: false } });
    const found = new Map<string, User>();
    for (let page = 1; ; page++) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw error;
        for (const u of data.users) {
            const e = u.email?.toLowerCase();
            if (e && wanted.has(e)) found.set(e, u);
        }
        if (data.users.length < 1000) break;
    }
    return { admin, found };
}

const banned = (u: User | undefined) => !!u?.banned_until && new Date(u.banned_until) > new Date();

async function main() {
    const apply = process.argv.includes("--apply");
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !service) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    const { db } = await import("@/lib/db");
    console.log(`Auth project: ${new URL(url).host}`);
    console.log(`DB host:      ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}`);
    console.log(apply ? "Mode: APPLY\n" : "Mode: dry run (add --apply to disable)\n");

    const all = [...DISABLE, ...REPORT_ONLY];
    const rows = (await db.execute(sql`
        SELECT id::text, lower(email) AS email, role, is_active
          FROM users WHERE lower(email) IN ${all}
    `)) as unknown as UserRow[];
    const byEmail = new Map(rows.map((r) => [r.email, r]));
    const { admin, found } = await authUsers(url, service, new Set(all));

    console.log("To disable:");
    let failed = 0;
    for (const email of DISABLE) {
        const row = byEmail.get(email);
        const auth = found.get(email);
        const state = `users=${row ? (row.is_active ? "active" : "inactive") : "none"} auth=${auth ? (banned(auth) ? "banned" : "open") : "none"}`;
        if (!row && !auth) {
            console.log(`  skip  ${email} — no login on this environment`);
            continue;
        }
        if (!apply) {
            console.log(`  plan  ${email} (${row?.role ?? "?"}) ${state}`);
            continue;
        }
        if (row) {
            await db.execute(sql`UPDATE users SET is_active = FALSE, updated_at = now() WHERE id = ${row.id}::uuid`);
        }
        if (auth && !banned(auth)) {
            const { error } = await admin.auth.admin.updateUserById(auth.id, { ban_duration: BAN });
            if (error) {
                failed++;
                console.log(`  FAIL  ${email} — ban: ${error.message}`);
                continue;
            }
        }
        console.log(`  done  ${email} (${row?.role ?? "?"}) was ${state}`);
    }

    const seats = (await db.execute(sql`
        SELECT count(*)::int AS n FROM feature_request_members WHERE is_active
    `)) as unknown as { n: number }[];
    if (apply) {
        await db.execute(sql`UPDATE feature_request_members SET is_active = FALSE, updated_at = now() WHERE is_active`);
        console.log(`\nFeature Request seats switched off: ${seats[0]?.n ?? 0}`);
    } else {
        console.log(`\nFeature Request seats that would be switched off: ${seats[0]?.n ?? 0}`);
    }

    console.log("\nLeft active (real people, made by the same tools):");
    for (const email of REPORT_ONLY) {
        const row = byEmail.get(email);
        if (!row) continue;
        console.log(`  keep  ${email} (${row.role ?? "?"}) users=${row.is_active ? "active" : "inactive"}`);
    }

    if (apply) {
        // Re-read on fresh state: every DISABLE login must now be inactive + banned.
        const after = (await db.execute(sql`
            SELECT lower(email) AS email FROM users WHERE lower(email) IN ${DISABLE} AND is_active
        `)) as unknown as { email: string }[];
        const recheck = await authUsers(url, service, new Set(DISABLE));
        const open = [...recheck.found.entries()].filter(([, u]) => !banned(u)).map(([e]) => e);
        if (after.length || open.length) {
            failed++;
            console.log(`\nCHECK FAILED — still active: ${after.map((r) => r.email).join(", ") || "-"}; not banned: ${open.join(", ") || "-"}`);
        } else {
            console.log("\nCheck: every listed login is inactive and banned.");
        }
    }
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
});
