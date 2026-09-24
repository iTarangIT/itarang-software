// Pending actions (assistant_actions). Gate 2 needs only the question the
// router asks before a typed "yes": is there an unexpired preview waiting?
// createPending / execute / cancel / sweep arrive in Gate 4.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export async function hasOpenPendingAction(userId: string): Promise<boolean> {
    const rows = await db.execute<{ one: number }>(sql`
        SELECT 1 AS one FROM assistant_actions
         WHERE user_id = ${userId}::uuid AND status = 'pending' AND expires_at > now()
         LIMIT 1
    `);
    return rows.length > 0;
}
