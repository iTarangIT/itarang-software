/**
 * Tell the database who is acting, for one transaction (E-304).
 *
 * The dealer_leads_audit trigger records interest changes and field edits, but
 * a trigger cannot see the logged-in user. Inside `withLeadActor`, it can:
 * `set_config('app.actor_id', …, true)` is LOCAL to the transaction, so it can
 * never leak onto another request that later borrows the same pooled
 * connection. Outside it, the trigger records changed_by = NULL — "not
 * recorded", never a guess.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function withLeadActor<T>(actorId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.actor_id', ${actorId}, true)`);
        return fn(tx);
    });
}
