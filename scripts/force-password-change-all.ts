// A39 — "force every user to change password at next login". Sets
// users.must_change_password = true for every ACTIVE staff login (dealers,
// NBFC partners, vendors and refurbishers have their own portals and are left
// alone). The dashboard then sends each of them to /change-password at their
// next page load; choosing a new password clears the flag and starts the
// 90-day clock (E-345).
//
//   node --import tsx --env-file=.env.local scripts/force-password-change-all.ts                 # dry run: lists who
//   node --import tsx --env-file=.env.local scripts/force-password-change-all.ts --commit
//   … --except=it@itarang.com,ceo@itarang.com    leave these logins alone (e.g. the person running it)
//
// For prod: export DATABASE_URL from .env.production first. Run it only after
// telling the team — everyone is stopped at their next click until they set a
// new password.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const except = new Set(
    (args.find((a) => a.startsWith("--except="))?.slice(9) ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
);
const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

async function main() {
    const host = new URL(process.env.DATABASE_URL ?? "postgres://unset").host.split(".")[0];
    console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} against ${host}\n`);
    const who = rowsOf<{ id: string; name: string | null; email: string | null; role: string; already: boolean }>(
        await db.execute(sql`
            SELECT id::text AS id, name, email, role, COALESCE(must_change_password, false) AS already
              FROM users
             WHERE is_active IS NOT FALSE
               AND lower(role) NOT IN ('dealer', 'nbfc_partner', 'vendor', 'refurbisher')
             ORDER BY role, name`),
    ).filter((u) => !except.has((u.email ?? "").toLowerCase()));
    for (const u of who) console.log(`  ${u.already ? "(already)" : "         "} ${u.role.padEnd(20)} ${u.name ?? "—"} <${u.email ?? "—"}>`);
    const todo = who.filter((u) => !u.already);
    console.log(`\n${todo.length} login(s) to flag, ${who.length - todo.length} already flagged, ${except.size} excepted.`);
    if (!COMMIT) {
        console.log("Dry run — nothing changed. Add --commit to flag them.");
        process.exit(0);
    }
    if (todo.length) {
        await db.execute(sql`
            UPDATE users SET must_change_password = true, updated_at = now()
             WHERE id::text IN ${todo.map((u) => u.id)}`);
    }
    console.log(`flagged ${todo.length}`);
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
