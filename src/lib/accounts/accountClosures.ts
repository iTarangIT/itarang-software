/**
 * Tracker ID 5 (E-332) — "Lost / closed dealer": an account closed by hand,
 * with a reason. A closed account leaves Dormant for its own "Closed" bucket
 * (accountHealthRules.ts); reopening deletes the row. accounts.status is never
 * touched — the dealer keeps its login and its history.
 *
 * Every reader goes through closedSql(), which reads "nobody is closed" on a
 * database without E-332, so nothing errors before the migration is applied.
 */
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { hasAccountClosuresTable } from "./tables";

/** Who may close or reopen a dealer account. */
export const ACCOUNT_CLOSE_ROLES = ["admin", "ceo", "sales_head"] as const;

/** `closed` (boolean) and `closed_reason` columns for the account id `accountId`. */
export async function closedColumns(accountId: SQL): Promise<SQL> {
    if (!(await hasAccountClosuresTable())) {
        return sql`FALSE AS closed, NULL::text AS closed_reason`;
    }
    return sql`EXISTS (SELECT 1 FROM account_closures ac_c WHERE ac_c.account_id = ${accountId}) AS closed,
               (SELECT ac_c.reason FROM account_closures ac_c WHERE ac_c.account_id = ${accountId}) AS closed_reason`;
}

export class ClosuresUnavailable extends Error {
    readonly status = 503;
    constructor() {
        super("Closing a dealer needs migration E-332 on this database.");
    }
}

/** Close an account with a reason (re-closing updates the reason). */
export async function closeAccount(accountId: string, reason: string, userId: string): Promise<boolean> {
    if (!(await hasAccountClosuresTable())) throw new ClosuresUnavailable();
    const rows = (await db.execute(sql`
        INSERT INTO account_closures (account_id, reason, closed_by)
        SELECT a.id, ${reason}, ${userId}::uuid FROM accounts a WHERE a.id = ${accountId}
        ON CONFLICT (account_id) DO UPDATE
           SET reason = EXCLUDED.reason, closed_by = EXCLUDED.closed_by, closed_at = now()
        RETURNING account_id
    `)) as unknown as unknown[];
    return rows.length > 0;
}

/** Reopen: the account is back in the ordinary buckets. */
export async function reopenAccount(accountId: string): Promise<void> {
    if (!(await hasAccountClosuresTable())) throw new ClosuresUnavailable();
    await db.execute(sql`DELETE FROM account_closures WHERE account_id = ${accountId}`);
}
