/**
 * Read-only developer check for tracker ID 174, decision 5: "add inventory to
 * the partner role once the developer confirms Chirag is the only partner
 * login; if not, Chirag gets a second login with the Inventory Manager role".
 *
 *   node --import tsx --env-file=.env.local scripts/verify-id174-partner-logins.ts
 *
 * Lists every login with role partner and inventory_manager (name, email,
 * active), says whether Chirag is the only ACTIVE partner, and reports the
 * E-348 stock-task tables and their open / overdue counts through the real
 * reader (stockTaskCounts). Writes nothing.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { stockTaskCounts } from "@/lib/inventory/stockUploadTasks/service";
import { STOCK_UPLOAD_ANY_DEALER_ROLES } from "@/lib/inventory/stockUploadRules";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    console.log(`database host: ${host}\n`);

    const logins = rowsOf<{ id: string; role: string; name: string | null; email: string | null; is_active: boolean | null }>(
        await db.execute(sql`
            SELECT id::text, role, name, email, is_active FROM users
             WHERE role IN ('partner', 'inventory_manager')
             ORDER BY role, created_at`),
    );
    for (const u of logins) {
        console.log(`${u.role.padEnd(18)} ${u.is_active === false ? "inactive" : "active  "} ${u.name ?? "—"} <${u.email ?? "—"}> ${u.id}`);
    }

    const activePartners = logins.filter((u) => u.role === "partner" && u.is_active !== false);
    const chirag = activePartners.filter((u) => /chirag/i.test(`${u.name ?? ""} ${u.email ?? ""}`));
    console.log(`\nactive partner logins: ${activePartners.length}`);
    if (activePartners.length === 1 && chirag.length === 1) {
        console.log("RESULT: Chirag is the only active partner login — partner gets inventory as decided.");
    } else {
        console.log(
            "RESULT: Chirag is NOT the only active partner login. Every active partner login gets Admin › Inventory and " +
                "stock upload for any dealer (roles: " + [...STOCK_UPLOAD_ANY_DEALER_ROLES].join(", ") + "). " +
                "Deactivate the others or give Chirag a second Inventory Manager login (decision 5).",
        );
    }

    const counts = await stockTaskCounts();
    console.log(
        counts
            ? `\nE-348 present · stock-upload tasks: ${counts.line}`
            : "\nE-348 missing on this database (no stock-upload tasks; the invoice scan runs as before)",
    );
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
