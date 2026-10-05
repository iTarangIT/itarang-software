// The account owner's e-mail, so dealer notifications copy them (tracker ID 65).
//
// Reads account_ownership (E-321) — the one account model. null when the
// dealer is not an account yet, has no owner, the owner is inactive, or the
// tables are not on this database.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { hasAccountOwnershipTables } from "@/lib/accounts/tables";

export async function accountOwnerEmail(dealerCode: string | null | undefined): Promise<string | null> {
    const code = (dealerCode ?? "").trim();
    if (!code) return null;
    try {
        if (!(await hasAccountOwnershipTables())) return null;
        const rows = (await db.execute(sql`
            SELECT u.email
              FROM account_ownership ao
              JOIN users u ON u.id = ao.owner_user_id
             WHERE ao.account_id = ${code} AND u.is_active
             LIMIT 1
        `)) as unknown as Array<{ email: string | null }>;
        return rows[0]?.email ?? null;
    } catch (err) {
        console.warn("[accounts] could not read the account owner", err);
        return null;
    }
}
