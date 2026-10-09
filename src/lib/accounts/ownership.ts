/**
 * E-321 — dealer account ownership (tracker ID 5 / handover P1-1, P1-2).
 *
 * An ACCOUNT is the onboarded dealer entity (`accounts`, id = dealer code).
 * Its OWNER is the iTarang salesperson credited with its invoices; "onboarded
 * by" is who brought it in. The two are kept apart on purpose: owner changes
 * never touch the onboarding record (dealer_onboarding_applications).
 *
 * History is append-only in account_owner_history: every change closes the
 * open window and opens a new one at `effectiveFrom`. Invoice credit reads the
 * window in force on the invoice date (gstinMatch.ts dealerAccountByGstin), so
 * a reassignment never moves revenue that was already reported.
 *
 * Nothing here assigns an owner by itself. suggestedOwners() is a hint shown
 * next to the "No owner" queue; a person always confirms it.
 */
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    accountOwnerHistory,
    accountOwnership,
    accounts,
    auditLogs,
} from "@/lib/db/schema";
import { generateId } from "@/lib/api-utils";
import { GSTIN_KEY } from "@/lib/leads/gstinMatch";
import { SALESPERSON_ROLES } from "@/lib/onboarding/salesperson";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Runner = typeof db | Tx;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CAME_THROUGH = ["lead", "direct"] as const;
export type CameThrough = (typeof CAME_THROUGH)[number];

export class OwnershipError extends Error {
    readonly status: number;
    constructor(message: string, status = 400) {
        super(message);
        this.status = status;
    }
}

/**
 * IST midnight of a YYYY-MM-DD day, as a Date. Effective dates are calendar
 * days in IST, the same day the invoice-date comparison uses.
 */
export function istDayStart(day: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        throw new OwnershipError(`Invalid date "${day}" — expected YYYY-MM-DD`);
    }
    return new Date(`${day}T00:00:00+05:30`);
}

/** The window [from, to) that contains IST day `day`, if any — pure, for tests. */
export function windowOn<T extends { effective_from: Date; effective_to: Date | null }>(
    windows: T[],
    day: string,
): T | null {
    const start = istDayStart(day).getTime();
    let best: T | null = null;
    for (const w of windows) {
        const from = w.effective_from.getTime();
        const to = w.effective_to?.getTime() ?? Number.POSITIVE_INFINITY;
        // Day granularity, as the SQL does: the window covers the IST day if it
        // started on or before it and ended after it.
        const fromDay = istDayStart(isoIstDay(w.effective_from)).getTime();
        const toDay = w.effective_to ? istDayStart(isoIstDay(w.effective_to)).getTime() : to;
        if (fromDay <= start && toDay > start) {
            if (!best || from > best.effective_from.getTime()) best = w;
        }
    }
    return best;
}

/** YYYY-MM-DD of an instant, in IST. */
export function isoIstDay(d: Date): string {
    return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

export interface AssignOwnerOptions {
    /** YYYY-MM-DD (IST). Defaults to today. Cannot be before the open window. */
    effectiveFrom?: string;
    reason: string;
    actorId: string;
}

/**
 * Set the owner of each account (NULL = unowned) from `effectiveFrom`.
 * Closes the open window, opens a new one, updates account_ownership, writes
 * one audit_logs row per account. Idempotent for an account already owned by
 * `ownerId` (skipped, reported as unchanged).
 */
export async function assignOwner(
    accountIds: string[],
    ownerId: string | null,
    opts: AssignOwnerOptions,
    tx?: Tx,
): Promise<{ changed: string[]; unchanged: string[] }> {
    const ids = [...new Set(accountIds.filter(Boolean))];
    if (ids.length === 0) return { changed: [], unchanged: [] };
    const reason = opts.reason.trim();
    if (!reason) throw new OwnershipError("A reason is required");

    const run = async (t: Tx) => {
        const found = await t
            .select({ id: accounts.id, created_at: accounts.created_at })
            .from(accounts)
            .where(inArray(accounts.id, ids));
        if (found.length !== ids.length) {
            const known = new Set(found.map((f) => f.id));
            throw new OwnershipError(
                `Unknown account(s): ${ids.filter((i) => !known.has(i)).join(", ")}`,
                404,
            );
        }
        const createdAt = new Map(found.map((f) => [f.id, f.created_at]));

        // Lock the open windows so two admins reassigning at once serialise.
        const open = await t
            .select()
            .from(accountOwnerHistory)
            .where(and(inArray(accountOwnerHistory.account_id, ids), isNull(accountOwnerHistory.effective_to)))
            .for("update");
        const openBy = new Map(open.map((o) => [o.account_id, o]));

        const changed: string[] = [];
        const unchanged: string[] = [];
        const now = new Date();
        for (const id of ids) {
            const cur = openBy.get(id);
            if (cur && (cur.owner_user_id ?? null) === (ownerId ?? null)) {
                unchanged.push(id);
                continue;
            }
            // First owner ever: default the window to the account's creation
            // so invoices since onboarding are credited to them. A later
            // change defaults to today.
            const from = opts.effectiveFrom
                ? istDayStart(opts.effectiveFrom)
                : cur
                  ? istDayStart(isoIstDay(now))
                  : (createdAt.get(id) ?? now);
            if (cur && from.getTime() <= cur.effective_from.getTime()) {
                throw new OwnershipError(
                    `Effective date for ${id} must be after the current owner's start (${isoIstDay(cur.effective_from)})`,
                );
            }
            if (cur) {
                await t
                    .update(accountOwnerHistory)
                    .set({ effective_to: from })
                    .where(eq(accountOwnerHistory.id, cur.id));
            }
            await t.insert(accountOwnerHistory).values({
                account_id: id,
                owner_user_id: ownerId,
                effective_from: from,
                reason,
                changed_by: opts.actorId,
            });
            await t
                .insert(accountOwnership)
                .values({ account_id: id, owner_user_id: ownerId, updated_by: opts.actorId })
                .onConflictDoUpdate({
                    target: accountOwnership.account_id,
                    set: { owner_user_id: ownerId, updated_by: opts.actorId, updated_at: now },
                });
            await t.insert(auditLogs).values({
                id: await generateId("AUDIT", auditLogs),
                entity_type: "account",
                entity_id: id,
                action: "account_owner_change",
                performed_by: opts.actorId,
                old_data: { owner_user_id: cur?.owner_user_id ?? null },
                new_data: { owner_user_id: ownerId, effective_from: from.toISOString(), reason },
            });
            changed.push(id);
        }
        return { changed, unchanged };
    };
    return tx ? run(tx) : db.transaction(run);
}

/**
 * Leaver bulk move: every account currently owned by `fromUserId` moves to
 * `toUserId` (or unowned) from `effectiveFrom`.
 */
export async function bulkMoveOwner(
    fromUserId: string,
    toUserId: string | null,
    opts: AssignOwnerOptions,
): Promise<{ changed: string[]; unchanged: string[] }> {
    if (fromUserId === toUserId) throw new OwnershipError("Choose a different new owner");
    const owned = await db
        .select({ id: accountOwnership.account_id })
        .from(accountOwnership)
        .where(eq(accountOwnership.owner_user_id, fromUserId));
    return assignOwner(
        owned.map((o) => o.id),
        toUserId,
        opts,
    );
}

/** The owner history of one account, newest first, with names. */
export async function ownerHistory(accountId: string) {
    const rows = (await db.execute(sql`
        SELECT h.id, h.owner_user_id::text AS owner_user_id, u.name AS owner_name,
               h.effective_from, h.effective_to, h.reason,
               h.changed_by::text AS changed_by, cb.name AS changed_by_name, h.created_at
          FROM account_owner_history h
          LEFT JOIN users u  ON u.id = h.owner_user_id
          LEFT JOIN users cb ON cb.id = h.changed_by
         WHERE h.account_id = ${accountId}
         ORDER BY h.effective_from DESC
    `)) as unknown as Array<Record<string, unknown>>;
    return rows;
}

/**
 * Suggested owner per account — a HINT for the "No owner" queue, never
 * applied automatically. ID 148: ONE ranking, used by the Accounts screen and
 * the Dealer accounts download alike:
 *   1. the salesperson recorded on the onboarding;
 *   2. the onboarding application's owner (set by Mark Converted);
 *   3. the linked lead's closing owner, then 4. its current owner;
 *   5. whoever filled the onboarding form;
 *   6. the sales manager typed on the onboarding, matched to a CRM user;
 *   7. the closing owner of another lead with the same GSTIN or phone.
 * Only active users in a sales role are suggested.
 */
export async function suggestedOwners(
    accountIds: string[],
    runner: Runner = db,
): Promise<Map<string, { user_id: string; name: string | null; basis: string }>> {
    const out = new Map<string, { user_id: string; name: string | null; basis: string }>();
    if (accountIds.length === 0) return out;
    const last10 = (expr: SQL): SQL => sql`right(regexp_replace(COALESCE(${expr}, ''), '[^0-9]', '', 'g'), 10)`;
    const roles = sql.join(SALESPERSON_ROLES.map((r) => sql`${r}`), sql`, `);
    const rows = (await runner.execute(sql`
        WITH acc AS (
            SELECT a.id AS account_id, a.gstin, a.contact_phone,
                   COALESCE(
                       (SELECT app.id FROM dealer_onboarding_applications app
                          JOIN dealers d ON d.application_id = app.id::text
                         WHERE d.dealer_id = a.id LIMIT 1),
                       (SELECT app.id FROM dealer_onboarding_applications app
                         WHERE app.dealer_code = a.id
                         ORDER BY app.created_at ASC LIMIT 1)) AS app_id
              FROM accounts a
             WHERE a.id IN (${sql.join(accountIds.map((i) => sql`${i}`), sql`, `)})
        ),
        lead AS (
            SELECT acc.account_id, dl.closing_owner_id, dl.current_owner_id
              FROM acc
              JOIN dealer_onboarding_applications app ON app.id = acc.app_id
              JOIN dealer_leads dl ON dl.id = COALESCE(app.originating_dealer_lead_id,
                   (SELECT x.id FROM dealer_leads x WHERE x.dealer_onboarding_application_id = app.id LIMIT 1))
        ),
        cand AS (
            SELECT acc.account_id, app.salesperson_user_id::text AS user_id, 'Salesperson on the onboarding' AS basis, 1 AS rank
              FROM acc JOIN dealer_onboarding_applications app ON app.id = acc.app_id
            UNION ALL
            SELECT acc.account_id, app.owner_id::text, 'Owner of the onboarding', 2
              FROM acc JOIN dealer_onboarding_applications app ON app.id = acc.app_id
            UNION ALL
            SELECT account_id, closing_owner_id, 'Closed the lead', 3 FROM lead
            UNION ALL
            SELECT account_id, current_owner_id, 'Owns the lead', 4 FROM lead
            UNION ALL
            SELECT acc.account_id, app.onboarding_operator_id::text, 'Filled the onboarding form', 5
              FROM acc JOIN dealer_onboarding_applications app ON app.id = acc.app_id
            UNION ALL
            SELECT acc.account_id, su.id::text, 'Typed as sales manager on the onboarding', 6
              FROM acc
              JOIN dealer_onboarding_applications app ON app.id = acc.app_id
              JOIN users su
                ON (app.sales_manager_email IS NOT NULL AND lower(su.email) = lower(btrim(app.sales_manager_email)))
                OR (length(${last10(sql`app.sales_manager_mobile`)}) = 10
                    AND ${last10(sql`su.phone`)} = ${last10(sql`app.sales_manager_mobile`)})
            UNION ALL
            SELECT acc.account_id, sl.closing_owner_id, 'Closed a lead with the same GSTIN or phone', 7
              FROM acc
              JOIN dealer_leads sl
                ON (${GSTIN_KEY(sql`sl.gstin`)} IS NOT NULL
                    AND upper(btrim(acc.gstin)) <> 'PENDING'
                    AND ${GSTIN_KEY(sql`sl.gstin`)} = ${GSTIN_KEY(sql`acc.gstin`)})
                OR (length(${last10(sql`acc.contact_phone`)}) = 10
                    AND ${last10(sql`sl.phone`)} = ${last10(sql`acc.contact_phone`)})
        )
        SELECT DISTINCT ON (c.account_id) c.account_id, u.id::text AS user_id, u.name, c.basis
          FROM cand c
          JOIN users u ON u.id::text = c.user_id
         WHERE u.is_active IS NOT FALSE
           AND lower(u.role) IN (${roles})
         ORDER BY c.account_id, c.rank
    `)) as unknown as Array<{ account_id: string; user_id: string; name: string | null; basis: string }>;
    for (const r of rows) out.set(r.account_id, { user_id: r.user_id, name: r.name, basis: r.basis });
    return out;
}

/**
 * Record how an account came in, at approval or by backfill. Never touches the
 * owner. Safe to call repeatedly: only fills what is still empty.
 */
export async function recordAccountOrigin(
    accountId: string,
    origin: {
        onboardedBy?: string | null;
        cameThrough: CameThrough;
        dealerLeadId?: string | null;
        applicationId?: string | null;
    },
    runner: Runner = db,
): Promise<void> {
    // owner_id / operator ids are text on the application; only a real uuid
    // can go into the uuid column.
    const onboardedBy =
        origin.onboardedBy && UUID_RE.test(origin.onboardedBy) ? origin.onboardedBy : null;
    await runner.execute(sql`
        INSERT INTO account_ownership
               (account_id, onboarded_by_user_id, came_through, source_dealer_lead_id, source_application_id)
        SELECT ${accountId}, ${onboardedBy}::uuid, ${origin.cameThrough},
               ${origin.dealerLeadId ?? null}, ${origin.applicationId ?? null}
         WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ${accountId})
        ON CONFLICT (account_id) DO UPDATE SET
            onboarded_by_user_id  = COALESCE(account_ownership.onboarded_by_user_id, EXCLUDED.onboarded_by_user_id),
            came_through          = CASE WHEN EXCLUDED.came_through = 'lead' THEN 'lead'
                                         ELSE COALESCE(account_ownership.came_through, EXCLUDED.came_through) END,
            source_dealer_lead_id = COALESCE(account_ownership.source_dealer_lead_id, EXCLUDED.source_dealer_lead_id),
            source_application_id = COALESCE(account_ownership.source_application_id, EXCLUDED.source_application_id),
            updated_at            = now()
    `);
}
