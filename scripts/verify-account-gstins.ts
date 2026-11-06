// CRM wording audit, CEO pages rows 9 / 26 (2-3 Nov): live dealer accounts
// whose GSTIN cannot match an invoice, so their invoices show "Not linked" on
// Accounts Receivable and are left out of Dealer Health. Read-only.
//
//   node --import tsx --env-file=.env.local scripts/verify-account-gstins.ts
//
// Writes reports/account-gstins-<date>.csv for Admin / Finance to fix on the
// account page (Accounts › account › GSTIN). Once a GSTIN is right, its
// invoices link on their own — nothing else to run.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";

import { checkGstin, isOwnGstin, normalizeGstin } from "@/lib/leads/gstin";

type Acct = { id: string; name: string | null; gstin: string | null; city: string | null; closed: boolean };

const csvCell = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
    const { db } = await import("@/lib/db");
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}\n`);
    const accounts = (await db.execute(sql`
        SELECT a.id, a.business_entity_name AS name, a.gstin, a.city,
               EXISTS (SELECT 1 FROM account_closures c WHERE c.account_id = a.id) AS closed
          FROM accounts a
         ORDER BY a.business_entity_name
    `)) as unknown as Acct[];

    const live = accounts.filter((a) => !a.closed);
    const problems = live
        .map((a) => {
            const g = normalizeGstin(a.gstin);
            let problem: string | null = null;
            if (!g || g === "PENDING") problem = "missing";
            else if (isOwnGstin(g)) problem = "iTarang's own GSTIN";
            else {
                const c = checkGstin(g);
                if (c === "bad_shape") problem = "invalid (wrong format)";
                else if (c === "bad_check_digit") problem = "invalid (typo: check digit)";
            }
            return { ...a, problem };
        })
        .filter((a) => a.problem);

    console.log(`Live accounts: ${live.length}; with a GSTIN that cannot match invoices: ${problems.length}`);
    for (const p of problems) console.log(`  ${p.problem?.padEnd(22)} ${p.name ?? "(unnamed)"} [${p.id}] GSTIN ${p.gstin || "—"}`);

    const dir = path.join(process.cwd(), "reports");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `account-gstins-${new Date().toISOString().slice(0, 10)}.csv`);
    const lines = [
        ["account_id", "dealer", "city", "gstin", "problem"].join(","),
        ...problems.map((p) => [p.id, p.name, p.city, p.gstin, p.problem].map(csvCell).join(",")),
    ];
    writeFileSync(file, lines.join("\n") + "\n", "utf8");
    console.log(`\nWrote ${file}`);
    process.exit(0);
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
});
