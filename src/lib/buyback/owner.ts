/**
 * Buyback request ownership (E-302, review R-12).
 *
 * Before this, a request had no owner and the Buyback Daily mail credited it to
 * "the latest admin to act on it" — the Sales Head, 136 times out of 153. Now a
 * request carries owner_id:
 *   * at creation  — the dealer's CRM owner, matched through the dealer
 *                    account's GSTIN (gstinMatch.ts, the same rule that
 *                    credits revenue); NULL when nothing matches;
 *   * on the admin request page — Claim (me) or Assign to (anyone who works
 *                    buyback). Each change is an 'assign_owner' row in
 *                    buyback_activity_log, in the same transaction.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { buybackActivityLog } from "@/lib/db/schema";
import { dealerLeadByGstin, GSTIN_KEY } from "@/lib/leads/gstinMatch";
import type { BuybackActor } from "@/lib/buyback/auth";
import { auditRoleOf } from "@/lib/buyback/transition";
import { BUYBACK_ADMIN_ROLES } from "@/lib/buyback/roles";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = Pick<typeof db, "execute">;

/**
 * Who can own a buyback request: everyone who works the buyback desk, plus the
 * field and inside-sales reps who source scrap from their own dealers.
 */
export const BUYBACK_OWNER_ROLES = [...BUYBACK_ADMIN_ROLES, "asm", "inside_sales_rep"] as const;

/** The dealer account's CRM owner via GSTIN, or null. Never throws. */
export async function defaultOwnerForEntity(
    dealerEntityId: string,
    exec: Exec = db,
): Promise<string | null> {
    try {
        const rows = (await exec.execute(sql`
            SELECT m.dealer_owner_id
              FROM accounts a
              JOIN ${dealerLeadByGstin(GSTIN_KEY(sql`a.gstin`))} m ON TRUE
             WHERE a.id = ${dealerEntityId}
        `)) as unknown as Array<{ dealer_owner_id: string | null }>;
        return rows[0]?.dealer_owner_id ?? null;
    } catch (e) {
        // A default owner is a convenience; failing to find one must never
        // stop a dealer creating a request.
        console.warn("[buyback/owner] default owner lookup failed", {
            error: e instanceof Error ? e.message : String(e),
        });
        return null;
    }
}

export type BuybackOwnerOption = { user_id: string; name: string | null; role: string | null };

export async function listBuybackOwnerOptions(): Promise<BuybackOwnerOption[]> {
    const rows = await db.execute(sql`
        SELECT u.id::text AS user_id, u.name, u.role
          FROM users u
         WHERE LOWER(u.role) IN (${sql.join(BUYBACK_OWNER_ROLES.map((r) => sql`${r}`), sql`, `)})
           AND u.is_active = TRUE
         ORDER BY u.name ASC NULLS LAST
    `);
    return rows as unknown as BuybackOwnerOption[];
}

export class BuybackOwnerError extends Error {}

/**
 * Set (or clear, with null) a request's owner, logging the change in the same
 * transaction. A no-op when the owner is unchanged.
 */
export async function setBuybackRequestOwner(
    requestId: string,
    ownerId: string | null,
    actor: BuybackActor,
): Promise<{ owner_id: string | null; changed: boolean }> {
    return db.transaction(async (tx: Tx) => {
        if (ownerId) {
            const ok = (await tx.execute(sql`
                SELECT 1 FROM users
                 WHERE id::text = ${ownerId} AND is_active = TRUE
                   AND LOWER(role) IN (${sql.join(BUYBACK_OWNER_ROLES.map((r) => sql`${r}`), sql`, `)})
            `)) as unknown as unknown[];
            if (ok.length === 0) {
                throw new BuybackOwnerError("That person can't own buyback requests, or is inactive.");
            }
        }

        const cur = (await tx.execute(sql`
            SELECT owner_id FROM buyback_requests WHERE id = ${requestId}::uuid FOR UPDATE
        `)) as unknown as Array<{ owner_id: string | null }>;
        if (cur.length === 0) throw new BuybackOwnerError("Request not found.");
        const before = cur[0].owner_id ?? null;
        if (before === ownerId) return { owner_id: ownerId, changed: false };

        await tx.execute(sql`
            UPDATE buyback_requests
               SET owner_id = ${ownerId}, owner_assigned_at = now(), updated_at = now()
             WHERE id = ${requestId}::uuid
        `);
        await tx.insert(buybackActivityLog).values({
            request_id: requestId,
            actor_id: actor.id,
            role: auditRoleOf(actor),
            action: "assign_owner",
            before: { owner_id: before } as never,
            after: { owner_id: ownerId } as never,
        });
        return { owner_id: ownerId, changed: true };
    });
}
