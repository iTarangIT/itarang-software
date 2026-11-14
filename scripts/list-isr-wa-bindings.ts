// ID 253 — read-only: every active ISR (and ASM, for reference), whether each has a linked
// WhatsApp number (assistant_wa_bindings status 'active') and whether saving is already on
// for them (ASSISTANT_WRITES_ENABLED_USER_IDS in the env this runs with). Prints the
// comma-separated id list to put in ASSISTANT_WRITES_ENABLED_USER_IDS. Changes nothing.
//
//   node --import tsx --env-file=.env.local scripts/list-isr-wa-bindings.ts        # sandbox
//   node --import tsx --env-file=.env.production scripts/list-isr-wa-bindings.ts   # live (you run it)
//
// Not linked: the rep opens CRM › Link WhatsApp and sends "LINK <code>" from their own phone.
// Phone numbers are printed masked (last 4).

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

type Row = { id: string; name: string | null; email: string; role: string; wa_phone: string | null; verified_at: string | null };

function mask(p: string | null): string {
    if (!p) return "—";
    const d = p.replace(/\D/g, "");
    return d.length >= 4 ? `••••${d.slice(-4)}` : "••••";
}

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    console.log(`DB host: ${host || "(unset)"}\n`);
    const enabled = new Set(
        (process.env.ASSISTANT_WRITES_ENABLED_USER_IDS ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    );

    const rows = (await db.execute(sql`
        SELECT u.id::text AS id, u.name, u.email, u.role,
               b.wa_phone, b.verified_at::text AS verified_at
          FROM users u
          LEFT JOIN assistant_wa_bindings b ON b.user_id = u.id AND b.status = 'active'
         WHERE u.is_active = true AND u.role IN ('inside_sales_rep', 'asm')
         ORDER BY u.role DESC, u.name
    `)) as unknown as Row[];

    for (const role of ["inside_sales_rep", "asm"]) {
        const list = rows.filter((r) => r.role === role);
        console.log(`${role === "asm" ? "ASMs" : "ISRs"} (${list.length} active)`);
        for (const r of list) {
            console.log(
                `  ${(r.name ?? r.email).padEnd(28)} WhatsApp: ${r.wa_phone ? `linked ${mask(r.wa_phone)}` : "NOT linked"}`.padEnd(62) +
                    ` saving: ${enabled.has(r.id) ? "on" : "off"}   ${r.id}`,
            );
        }
        console.log("");
    }

    const isrs = rows.filter((r) => r.role === "inside_sales_rep");
    const want = [...new Set([...enabled, ...isrs.map((r) => r.id)])];
    console.log(`ISRs linked: ${isrs.filter((r) => r.wa_phone).length} of ${isrs.length}`);
    console.log(`\nASSISTANT_WRITES_ENABLED_USER_IDS with every active ISR added (keeps the ids already there):\n${want.join(",")}`);
    console.log("\nSet it in the GitHub secret (PROD_ENV_FILE_B64) AND on the live server, then reload (RUNBOOK §2, §6, §13).");
    process.exit(0);
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
