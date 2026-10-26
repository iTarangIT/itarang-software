// E-358 — who may raise an account quotation, on real accounts and users.
//
//   node --import tsx --env-file=.env.local scripts/verify-account-quotations.ts
//
// READ-ONLY. Picks sample accounts — one owned by Sonu (ASM) if any, one owned
// by a member of Sonu's team, one owned by someone else, one with no owner —
// and sample users (Sonu, a team member, an unrelated ISR, Sales Head, CEO,
// Partner, Admin), then prints canCreate / canView from the real
// accountQuoteAccess (src/lib/accounts/quotations/access.ts). Also says
// whether E-358 is applied on this database. Writes nothing.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accountQuoteAccess, hasAccountQuotationTables } from "@/lib/accounts/quotations/access";
import { getTeamMemberIds } from "@/lib/users/team";

type U = { id: string; name: string; role: string; email: string };
type A = { id: string; name: string; owner_id: string | null; owner_name: string | null };

const rows = <T>(r: unknown) => r as T[];

async function main() {
    const host = (process.env.DATABASE_URL ?? "").match(/@([^:/]+)/)?.[1] ?? "?";
    console.log(`DB host: ${host}`);
    console.log(`E-358 applied: ${await hasAccountQuotationTables()}`);

    const sonu = rows<U>(
        await db.execute(sql`SELECT id::text, name, role, email FROM users
                              WHERE is_active AND (lower(name) LIKE 'sonu%' OR lower(email) LIKE 'sonu%')
                              ORDER BY (role = 'asm') DESC LIMIT 1`),
    )[0];
    const team = sonu ? await getTeamMemberIds(sonu.id) : [];
    console.log(`Sonu: ${sonu ? `${sonu.name} <${sonu.email}> (${sonu.role})` : "not found"} — team ${team.length}`);

    const pick = async (role: string, exclude: string[] = []) =>
        rows<U>(
            await db.execute(sql`SELECT id::text, name, role, email FROM users
                                  WHERE is_active AND role = ${role}
                                    ${exclude.length ? sql`AND id::text NOT IN (${sql.join(exclude.map((e) => sql`${e}`), sql`, `)})` : sql``}
                                  ORDER BY name LIMIT 1`),
        )[0];

    const accts = rows<A>(
        await db.execute(sql`SELECT a.id, a.business_entity_name AS name, ao.owner_user_id::text AS owner_id, u.name AS owner_name
                               FROM accounts a
                               LEFT JOIN account_ownership ao ON ao.account_id = a.id
                               LEFT JOIN users u ON u.id = ao.owner_user_id
                              ORDER BY a.created_at DESC`),
    );
    const sample: Array<[string, A | undefined]> = [
        ["owned by Sonu", accts.find((a) => sonu && a.owner_id === sonu.id)],
        ["owned by Sonu's team", accts.find((a) => a.owner_id && team.includes(a.owner_id))],
        ["owned by someone else", accts.find((a) => a.owner_id && a.owner_id !== sonu?.id && !team.includes(a.owner_id))],
        ["no owner", accts.find((a) => !a.owner_id)],
    ];

    const teamMember = team.length
        ? rows<U>(await db.execute(sql`SELECT id::text, name, role, email FROM users WHERE id::text = ${team[0]}`))[0]
        : undefined;
    const outsiderIsr = await pick("inside_sales_rep", [sonu?.id, ...team].filter(Boolean) as string[]);
    const people: Array<[string, U | undefined]> = [
        ["Sonu (ASM)", sonu],
        ["Sonu's team member", teamMember],
        ["unrelated ISR", outsiderIsr],
        ["sales_head", await pick("sales_head")],
        ["ceo", await pick("ceo")],
        ["partner", await pick("partner")],
        ["admin", await pick("admin")],
    ];

    for (const [label, a] of sample) {
        if (!a) {
            console.log(`\n[${label}] — no such account on this DB`);
            continue;
        }
        console.log(`\n[${label}] ${a.name} (${a.id}) — owner: ${a.owner_name ?? "none"}`);
        for (const [who, u] of people) {
            if (!u) {
                console.log(`   ${who.padEnd(20)} — no such user`);
                continue;
            }
            const acc = await accountQuoteAccess({ id: u.id, role: u.role }, a.id);
            const verdict = acc?.canCreate ? "CAN create" : acc?.canView ? "view only" : "NO access";
            console.log(`   ${who.padEnd(20)} ${u.name.padEnd(22)} ${verdict}`);
        }
    }
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
