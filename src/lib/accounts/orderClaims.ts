/**
 * Tracker ID 5 (E-334) — "Order placed".
 *
 * The invoice is the order. This is the safety net for the days before
 * accounts raise one: the salesperson records the order date and PO number,
 * and for ORDER_CLAIM_WINDOW_DAYS from the order date the dealer ages from the
 * order instead of its last invoice (accountHealth.ts). An invoice for the
 * account dated inside the window confirms the claim and takes over. With no
 * invoice, ageing resumes and the claim is listed as "Order claimed, no invoice
 * raised" — for sales and finance — until someone withdraws it.
 *
 * A claim's status is worked out from the invoices every time it is read
 * (claimStatusSql mirrors accountHealthRules.orderClaimStatus), so a late
 * invoice or a voided one re-decides it with no backfill.
 */
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { matchedUnion, REVENUE_NOT_VOID } from "@/lib/dashboard/revenueSource";
import {
    ORDER_CLAIM_WINDOW_DAYS,
    orderClaimStatus,
    type OrderClaimStatus,
} from "@/lib/dealers/accountHealthRules";
import { invoiceAccountSql } from "./accountList";
import { ACCOUNT_CLOSE_ROLES } from "./accountClosures";
import { hasOrderClaimTables } from "./tables";

type Exec = Pick<typeof db, "execute">;

/** Who may record or withdraw a claim on ANY account; an owner may on their own. */
export const ORDER_CLAIM_MANAGER_ROLES = ACCOUNT_CLOSE_ROLES;

/** Who may see the "Order claimed, no invoice raised" list for every account. */
export const ORDER_CLAIM_VIEW_ROLES = [
    ...ACCOUNT_CLOSE_ROLES,
    "business_head",
    "partner",
    "finance_controller",
] as const;

export class OrderClaimsUnavailable extends Error {
    readonly status = 503;
    constructor() {
        super("Recording an order needs migration E-334 on this database.");
    }
}

export class OrderClaimError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

/**
 * `inv` CTE: every non-void invoice with the account it counts for (the
 * ID 148 key), materialised once so the orders and the claims read one scan.
 * Needs a `today` CTE before it, as accountHealth.ts has.
 */
export async function invoicesByAccountCte(): Promise<SQL> {
    const invoices = await matchedUnion();
    const k = invoiceAccountSql();
    return sql`inv AS MATERIALIZED (
        SELECT ${k} AS k, r.invoice_date, r.total
          FROM ${invoices} AS r
         WHERE ${k} IS NOT NULL AND ${REVENUE_NOT_VOID}
    )`;
}

/**
 * `claim_state` CTE over every claim, with its computed status. Needs the
 * `today` and `inv` CTEs before it.
 */
export const claimStateCte = sql`claim_state AS (
    SELECT c.id, c.account_id, c.order_date, c.po_number, c.note, c.claimed_by,
           c.claimed_at, c.withdrawn_at,
           ((SELECT d FROM today) - c.order_date) AS days_since_order,
           (c.withdrawn_at IS NOT NULL) AS withdrawn,
           EXISTS (SELECT 1 FROM inv
                    WHERE inv.k = c.account_id
                      AND inv.invoice_date BETWEEN c.order_date
                                               AND c.order_date + ${ORDER_CLAIM_WINDOW_DAYS}::int) AS invoiced
      FROM account_order_claims c
)`;

/** SQL mirror of orderClaimStatus() over a claim_state row `s`. */
export const claimStatusSql = sql`(CASE
    WHEN s.withdrawn THEN 'withdrawn'
    WHEN s.invoiced THEN 'confirmed'
    WHEN s.days_since_order <= ${ORDER_CLAIM_WINDOW_DAYS}::int THEN 'pending'
    ELSE 'unconfirmed' END)`;

export type OrderClaimRow = {
    id: number;
    account_id: string;
    dealer: string;
    owner_id: string | null;
    owner_name: string | null;
    order_date: string;
    po_number: string | null;
    note: string | null;
    claimed_by_name: string | null;
    claimed_at: string;
    days_since_order: number;
    /** Days past the end of the window ("unconfirmed" only), else 0. */
    days_overdue: number;
    status: OrderClaimStatus;
};

/**
 * Claims with their status, newest order first. `status` narrows the list;
 * `ownerId` keeps one owner's accounts. Empty without E-334.
 */
export async function listOrderClaims(
    opts: {
        status?: OrderClaimStatus | "open";
        ownerId?: string;
        accountId?: string;
    } = {},
    exec: Exec = db,
): Promise<OrderClaimRow[]> {
    if (!(await hasOrderClaimTables())) return [];
    const statusFilter =
        opts.status === "open"
            ? sql`${claimStatusSql} IN ('pending', 'unconfirmed')`
            : opts.status
              ? sql`${claimStatusSql} = ${opts.status}`
              : sql`TRUE`;
    const ownerFilter = opts.ownerId ? sql`ao.owner_user_id::text = ${opts.ownerId}` : sql`TRUE`;
    const accountFilter = opts.accountId ? sql`s.account_id = ${opts.accountId}` : sql`TRUE`;
    const rows = (await exec.execute(sql`
        WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d),
        ${await invoicesByAccountCte()},
        ${claimStateCte}
        SELECT s.id, s.account_id, a.business_entity_name AS dealer,
               ao.owner_user_id::text AS owner_id, ou.name AS owner_name,
               s.order_date::text AS order_date, s.po_number, s.note,
               cu.name AS claimed_by_name, s.claimed_at::text AS claimed_at,
               s.days_since_order, s.withdrawn, s.invoiced
          FROM claim_state s
          JOIN accounts a ON a.id = s.account_id
          LEFT JOIN account_ownership ao ON ao.account_id = s.account_id
          LEFT JOIN users ou ON ou.id = ao.owner_user_id
          LEFT JOIN users cu ON cu.id = s.claimed_by
         WHERE ${statusFilter} AND ${ownerFilter} AND ${accountFilter}
         ORDER BY s.order_date DESC, s.id DESC
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => {
        const days = Number(r.days_since_order);
        const status = orderClaimStatus({
            withdrawn: r.withdrawn === true,
            invoiced: r.invoiced === true,
            daysSinceOrder: days,
        });
        return {
            id: Number(r.id),
            account_id: String(r.account_id),
            dealer: String(r.dealer ?? "(unnamed)"),
            owner_id: (r.owner_id as string | null) ?? null,
            owner_name: (r.owner_name as string | null) ?? null,
            order_date: String(r.order_date).slice(0, 10),
            po_number: (r.po_number as string | null) ?? null,
            note: (r.note as string | null) ?? null,
            claimed_by_name: (r.claimed_by_name as string | null) ?? null,
            claimed_at: String(r.claimed_at),
            days_since_order: days,
            days_overdue: status === "unconfirmed" ? days - ORDER_CLAIM_WINDOW_DAYS : 0,
            status,
        };
    });
}

/** The account's current owner (E-321), or null. */
async function accountOwner(accountId: string): Promise<{ exists: boolean; ownerId: string | null }> {
    const rows = (await db.execute(sql`
        SELECT a.id, ao.owner_user_id::text AS owner_id
          FROM accounts a
          LEFT JOIN account_ownership ao ON ao.account_id = a.id
         WHERE a.id = ${accountId}
    `)) as unknown as Array<{ owner_id: string | null }>;
    return { exists: rows.length > 0, ownerId: rows[0]?.owner_id ?? null };
}

/** May this user record / withdraw a claim on this account? */
export async function canActOnAccount(
    user: { id: string; role: string },
    accountId: string,
): Promise<boolean> {
    if ((ORDER_CLAIM_MANAGER_ROLES as readonly string[]).includes(user.role)) return true;
    const { ownerId } = await accountOwner(accountId);
    return ownerId != null && ownerId === user.id;
}

/** Today in IST, YYYY-MM-DD. */
function istToday(now = new Date()): string {
    return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
    return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/**
 * Record "Order placed". The order date must be today or within the window
 * behind it (an older order could never be confirmed), and an account has one
 * open claim at a time — withdraw the old one first.
 */
export async function recordOrderClaim(
    user: { id: string; role: string },
    accountId: string,
    input: { orderDate: string; poNumber?: string | null; note?: string | null },
): Promise<{ id: number }> {
    if (!(await hasOrderClaimTables())) throw new OrderClaimsUnavailable();
    const { exists } = await accountOwner(accountId);
    if (!exists) throw new OrderClaimError("Account not found", 404);
    if (!(await canActOnAccount(user, accountId))) {
        throw new OrderClaimError("Only the dealer's owner or a sales manager can record an order.", 403);
    }
    const age = daysBetween(input.orderDate, istToday());
    if (age < 0) throw new OrderClaimError("The order date cannot be in the future.", 400);
    if (age > ORDER_CLAIM_WINDOW_DAYS) {
        throw new OrderClaimError(
            `The order date must be within the last ${ORDER_CLAIM_WINDOW_DAYS} days.`,
            400,
        );
    }
    // One open claim per account. The check and the insert share a
    // transaction-scoped lock on the account, so two clicks cannot both pass.
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`order-claim:${accountId}`}))`);
        const [existing] = await listOrderClaims({ status: "open", accountId }, tx);
        if (existing) {
            throw new OrderClaimError(
                existing.status === "pending"
                    ? `An order placed on ${existing.order_date} is still awaiting its invoice.`
                    : `The order placed on ${existing.order_date} never got an invoice — withdraw it first.`,
                409,
            );
        }
        const rows = (await tx.execute(sql`
            INSERT INTO account_order_claims (account_id, order_date, po_number, note, claimed_by)
            VALUES (${accountId}, ${input.orderDate}::date, ${input.poNumber?.trim() || null},
                    ${input.note?.trim() || null}, ${user.id}::uuid)
            RETURNING id
        `)) as unknown as Array<{ id: number | string }>;
        return { id: Number(rows[0].id) };
    });
}

/** Withdraw a claim (no order after all, or a duplicate). */
export async function withdrawOrderClaim(
    user: { id: string; role: string },
    claimId: number,
    reason: string,
): Promise<void> {
    if (!(await hasOrderClaimTables())) throw new OrderClaimsUnavailable();
    const rows = (await db.execute(sql`
        SELECT account_id, withdrawn_at FROM account_order_claims WHERE id = ${claimId}
    `)) as unknown as Array<{ account_id: string; withdrawn_at: string | null }>;
    if (rows.length === 0) throw new OrderClaimError("Order claim not found", 404);
    if (!(await canActOnAccount(user, rows[0].account_id))) {
        throw new OrderClaimError("Only the dealer's owner or a sales manager can withdraw this order.", 403);
    }
    if (rows[0].withdrawn_at) return;
    await db.execute(sql`
        UPDATE account_order_claims
           SET withdrawn_at = now(), withdrawn_by = ${user.id}::uuid, withdrawn_reason = ${reason}
         WHERE id = ${claimId} AND withdrawn_at IS NULL
    `);
}
