/**
<<<<<<< HEAD
 * Dealer account ownership (tracker ID 65, E-322).
 *
 * Two people on an account:
 *   onboarded by   fixed at activation — never changed here
 *   account owner  changes with reassignment; every change is one row in
 *                  account_ownership_history (from, to, reason, effective
 *                  date, who made it)
 *
 * An owner is always picked by a person — nothing here assigns on its own —
 * and must be an active ISR, ASM or Sales Head. Owner changes never touch the
 * onboarding record.
 */
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { accountOwnershipHistory, accounts, dealers, users } from "@/lib/db/schema";
import { checkCustomerGstin, GSTIN_CHECK_MESSAGE, normalizeGstin } from "@/lib/leads/gstin";
import { resolveSalesperson } from "@/lib/onboarding/salesperson";

export class AccountActionError extends Error {
    constructor(
        message: string,
        readonly status = 400,
    ) {
        super(message);
    }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const ACCOUNT_REASON_MIN = 5;
export const ACCOUNT_BULK_CAP = 500;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function todayIst(): Promise<string> {
    const [r] = (await db.execute(sql`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)) as unknown as { d: string }[];
    return r.d;
}

function checkReason(reason: string): string {
    const r = reason.trim();
    if (r.length < ACCOUNT_REASON_MIN) throw new AccountActionError("Give a reason for the change.");
    return r;
}

async function checkEffectiveDate(value: string | null | undefined): Promise<string> {
    const today = await todayIst();
    const d = (value ?? "").trim() || today;
    if (!ISO_DATE.test(d)) throw new AccountActionError("The effective date is not a valid date.");
    if (d > today) throw new AccountActionError("The effective date cannot be in the future.");
    return d;
}

async function moveOwner(
    tx: Tx,
    rows: { id: string; account_owner_id: string | null; account_owner_since: string | null }[],
    toOwnerId: string,
    reason: string,
    effectiveDate: string,
    changedBy: string,
): Promise<number> {
    const moving = rows.filter((r) => r.account_owner_id !== toOwnerId);
    if (moving.length === 0) return 0;
    // A change dated before the current owner took over would put the history
    // out of order and hand the new owner days that belonged to someone else.
    const tooEarly = moving.filter((r) => r.account_owner_id && r.account_owner_since && effectiveDate < r.account_owner_since);
    if (tooEarly.length > 0) {
        const latest = tooEarly.map((r) => r.account_owner_since!).sort().at(-1);
        throw new AccountActionError(
            tooEarly.length === 1 && moving.length === 1
                ? `The effective date is before the current owner took over (${latest}).`
                : `The effective date is before the current owner took over on ${tooEarly.length} of the selected accounts (latest: ${latest}).`,
        );
    }
    await tx.insert(accountOwnershipHistory).values(
        moving.map((r) => ({
            account_id: r.id,
            from_owner_id: r.account_owner_id,
            to_owner_id: toOwnerId,
            reason,
            effective_date: effectiveDate,
            changed_by: changedBy,
        })),
    );
    await tx
        .update(accounts)
        .set({ account_owner_id: toOwnerId, account_owner_since: effectiveDate, updated_at: new Date() })
        .where(inArray(accounts.id, moving.map((r) => r.id)));
    return moving.length;
}

/** Assign or reassign one account or many. Returns how many actually changed owner. */
export async function assignAccountOwner(input: {
    accountIds: string[];
    toOwnerId: string;
    reason: string;
    effectiveDate?: string | null;
    changedBy: string;
}): Promise<{ changed: number; unchanged: number }> {
    const ids = [...new Set(input.accountIds.map((i) => i.trim()).filter(Boolean))];
    if (ids.length === 0) throw new AccountActionError("Select at least one account.");
    if (ids.length > ACCOUNT_BULK_CAP) throw new AccountActionError(`Select at most ${ACCOUNT_BULK_CAP} accounts at a time.`);
    const reason = checkReason(input.reason);
    const effectiveDate = await checkEffectiveDate(input.effectiveDate);
    const owner = await resolveSalesperson(input.toOwnerId);
    if (!owner) throw new AccountActionError("The owner must be an active ISR, ASM or Sales Head.");

    return db.transaction(async (tx) => {
        const rows = await tx
            .select({ id: accounts.id, account_owner_id: accounts.account_owner_id, account_owner_since: accounts.account_owner_since })
            .from(accounts)
            .innerJoin(dealers, eq(dealers.dealer_id, accounts.id))
            .where(inArray(accounts.id, ids))
            .for("update", { of: accounts });
        if (rows.length !== ids.length) throw new AccountActionError("One or more of the selected accounts is not a dealer account.", 404);
        const changed = await moveOwner(tx, rows, owner.id, reason, effectiveDate, input.changedBy);
        return { changed, unchanged: rows.length - changed };
    });
}

/** A leaver's accounts, moved to one new owner in one step. */
export async function moveLeaverAccounts(input: {
    fromOwnerId: string;
    toOwnerId: string;
    reason: string;
    effectiveDate?: string | null;
    changedBy: string;
}): Promise<{ changed: number }> {
    if (input.fromOwnerId === input.toOwnerId) throw new AccountActionError("Pick a different person to move the accounts to.");
    const reason = checkReason(input.reason);
    const effectiveDate = await checkEffectiveDate(input.effectiveDate);
    const owner = await resolveSalesperson(input.toOwnerId);
    if (!owner) throw new AccountActionError("The new owner must be an active ISR, ASM or Sales Head.");

    return db.transaction(async (tx) => {
        const rows = await tx
            .select({ id: accounts.id, account_owner_id: accounts.account_owner_id, account_owner_since: accounts.account_owner_since })
            .from(accounts)
            .where(eq(accounts.account_owner_id, input.fromOwnerId))
            .for("update");
        const changed = await moveOwner(tx, rows, owner.id, reason, effectiveDate, input.changedBy);
        return { changed };
    });
}

/**
 * The account's owner on a given day (YYYY-MM-DD), from the history — what
 * invoice credit uses (ID 68), so past revenue never moves with a reassignment.
 * null = nobody owned it yet.
 */
export async function ownerOn(accountId: string, date: string): Promise<string | null> {
    const [row] = await db
        .select({ to_owner_id: accountOwnershipHistory.to_owner_id })
        .from(accountOwnershipHistory)
        .where(and(eq(accountOwnershipHistory.account_id, accountId), lte(accountOwnershipHistory.effective_date, date)))
        .orderBy(desc(accountOwnershipHistory.effective_date), desc(accountOwnershipHistory.created_at))
        .limit(1);
    return row?.to_owner_id ?? null;
}

export type OwnershipHistoryRow = {
    id: string;
    from_owner: string | null;
    to_owner: string | null;
    reason: string;
    effective_date: string;
    changed_by: string | null;
    created_at: string;
};

export async function listOwnershipHistory(accountId: string): Promise<OwnershipHistoryRow[]> {
    const rows = (await db.execute(sql`
        SELECT h.id::text, fu.name AS from_owner, tu.name AS to_owner, h.reason,
               h.effective_date::text AS effective_date, cu.name AS changed_by, h.created_at::text AS created_at
          FROM account_ownership_history h
          LEFT JOIN users fu ON fu.id = h.from_owner_id
          LEFT JOIN users tu ON tu.id = h.to_owner_id
          LEFT JOIN users cu ON cu.id = h.changed_by
         WHERE h.account_id = ${accountId}
         ORDER BY h.effective_date DESC, h.created_at DESC
    `)) as unknown as OwnershipHistoryRow[];
=======
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
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    accountOwnerHistory,
    accountOwnership,
    accounts,
    auditLogs,
} from "@/lib/db/schema";
import { generateId } from "@/lib/api-utils";

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
>>>>>>> fac2a80905456e04c4d89ee14f26fdf80ae34f9e
    return rows;
}

/**
<<<<<<< HEAD
 * "Came through: Lead — linked where the phone matches an existing lead"
 * (ID 65). For an onboarding that was not started from a lead: the dealer lead
 * with the same mobile number, if there is one. A lead already won is
 * preferred, then the newest.
 *
 * This only records where the account came from. It does not move the lead to
 * Converted — that stays with the application the lead points at (ID 84.4).
 *
 * Reads on its own connection and never throws, so it can be called while the
 * approve transaction is open without putting that transaction at risk.
 */
export async function leadMatchingPhone(phone: string | null | undefined): Promise<string | null> {
    const digits = (phone ?? "").replace(/\D/g, "").slice(-10);
    if (digits.length !== 10) return null;
    try {
        const rows = (await db.execute(sql`
            SELECT dl.id
              FROM dealer_leads dl
             WHERE right(regexp_replace(COALESCE(dl.phone, ''), '[^0-9]', '', 'g'), 10) = ${digits}
               AND dl.is_active IS NOT FALSE
             ORDER BY (dl.lead_status IN ('Won', 'Converted')) DESC NULLS LAST, dl.created_at DESC NULLS LAST
             LIMIT 1
        `)) as unknown as { id: string }[];
        return rows[0]?.id ?? null;
    } catch (err) {
        console.warn("[accounts] could not match a lead by phone", err);
        return null;
    }
}

/**
 * At activation: who onboarded the dealer (fixed) and the first owner. Both
 * are the onboarding's salesperson — a person picked them there — and the
 * first history row records it. Runs inside the approve transaction.
 */
export async function stampAccountAtActivation(
    tx: Tx,
    input: { accountId: string; salespersonUserId: string | null; leadId: string | null; changedBy: string },
): Promise<void> {
    const [{ d: today }] = (await tx.execute(
        sql`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`,
    )) as unknown as { d: string }[];
    await tx
        .update(accounts)
        .set({
            onboarded_by_user_id: input.salespersonUserId,
            account_owner_id: input.salespersonUserId,
            account_owner_since: input.salespersonUserId ? today : null,
            came_through: input.leadId ? "lead" : "direct",
            originating_dealer_lead_id: input.leadId,
            activated_at: new Date(),
        })
        .where(eq(accounts.id, input.accountId));
    if (input.salespersonUserId) {
        await tx.insert(accountOwnershipHistory).values({
            account_id: input.accountId,
            from_owner_id: null,
            to_owner_id: input.salespersonUserId,
            reason: "Onboarded the dealer",
            effective_date: today,
            changed_by: input.changedBy,
        });
    }
}

/** The account owner's email for a dealer onboarding, so dealer notifications copy them. */
export async function accountOwnerEmailForApplication(application: {
    dealer_code?: string | null;
}): Promise<string | null> {
    const code = (application.dealer_code ?? "").trim();
    if (!code) return null;
    try {
        const [row] = await db
            .select({ email: users.email })
            .from(accounts)
            .innerJoin(users, eq(users.id, accounts.account_owner_id))
            .where(and(eq(accounts.id, code), eq(users.is_active, true)))
            .limit(1);
        return row?.email ?? null;
    } catch (err) {
        console.warn("[accounts] could not read the account owner (E-322 applied?)", err);
        return null;
    }
}

/**
 * Correct GSTIN — an action on the ACCOUNT, never on the onboarding. Covers a
 * missing ("PENDING") and a wrong GSTIN. Recorded with who and when.
 */
export async function correctAccountGstin(input: {
    accountId: string;
    gstin: string;
    correctedBy: string;
}): Promise<{ gstin: string; previous: string }> {
    const gstin = normalizeGstin(input.gstin);
    const check = checkCustomerGstin(gstin);
    if (check !== "ok") throw new AccountActionError(GSTIN_CHECK_MESSAGE[check]);

    return db.transaction(async (tx) => {
        const [row] = await tx
            .select({ id: accounts.id, gstin: accounts.gstin })
            .from(accounts)
            .innerJoin(dealers, eq(dealers.dealer_id, accounts.id))
            .where(eq(accounts.id, input.accountId))
            .for("update", { of: accounts });
        if (!row) throw new AccountActionError("Dealer account not found.", 404);
        if (normalizeGstin(row.gstin) === gstin) throw new AccountActionError("That is already this account's GSTIN.");

        const [clash] = await tx
            .select({ id: accounts.id, name: accounts.business_entity_name })
            .from(accounts)
            .where(eq(accounts.gstin, gstin))
            .limit(1);
        if (clash) throw new AccountActionError(`This GSTIN is already on another account (${clash.name}).`, 409);

        await tx
            .update(accounts)
            .set({ gstin, gstin_corrected_at: new Date(), gstin_corrected_by: input.correctedBy, updated_at: new Date() })
            .where(eq(accounts.id, input.accountId));
        return { gstin, previous: row.gstin };
    });
}

/** Who last corrected the account's GSTIN, and when; null when it never was. */
export async function gstinCorrection(accountId: string): Promise<{ at: string; by: string | null } | null> {
    const [r] = (await db.execute(sql`
        SELECT (a.gstin_corrected_at AT TIME ZONE 'Asia/Kolkata')::date::text AS at, u.name AS by
          FROM accounts a
          LEFT JOIN users u ON u.id = a.gstin_corrected_by
         WHERE a.id = ${accountId} AND a.gstin_corrected_at IS NOT NULL
    `)) as unknown as { at: string; by: string | null }[];
    return r ?? null;
}

/** Does the account's onboarding already hold a GST certificate? */
export async function gstCertificateOnFile(accountId: string): Promise<boolean> {
    const [r] = (await db.execute(sql`
        SELECT EXISTS (
            SELECT 1
              FROM dealers d
              JOIN dealer_onboarding_documents doc ON doc.application_id::text = d.application_id
             WHERE d.dealer_id = ${accountId}
               AND doc.document_type IN ('gst_certificate', 'gst')
               AND COALESCE(doc.doc_status, '') <> 'superseded'
        ) AS on_file
    `)) as unknown as { on_file: boolean }[];
    return r?.on_file === true;
=======
 * Suggested owner per account — a HINT for the "No owner" queue, never
 * applied automatically. Order: the onboarding application's owner_id (set by
 * Mark Converted), then the linked lead's closing owner, then its current
 * owner. Only active users are suggested.
 */
export async function suggestedOwners(
    accountIds: string[],
    runner: Runner = db,
): Promise<Map<string, { user_id: string; name: string | null; basis: string }>> {
    const out = new Map<string, { user_id: string; name: string | null; basis: string }>();
    if (accountIds.length === 0) return out;
    const rows = (await runner.execute(sql`
        WITH acc AS (
            SELECT a.id AS account_id,
                   (SELECT app.id FROM dealer_onboarding_applications app
                     WHERE app.dealer_code = a.id
                     ORDER BY app.created_at ASC LIMIT 1) AS app_id
              FROM accounts a
             WHERE a.id IN (${sql.join(accountIds.map((i) => sql`${i}`), sql`, `)})
        ),
        cand AS (
            SELECT acc.account_id, app.owner_id AS user_id, 'onboarding owner' AS basis, 1 AS rank
              FROM acc JOIN dealer_onboarding_applications app ON app.id = acc.app_id
            UNION ALL
            SELECT acc.account_id, dl.closing_owner_id, 'lead closing owner', 2
              FROM acc
              JOIN dealer_onboarding_applications app ON app.id = acc.app_id
              JOIN dealer_leads dl ON dl.id = COALESCE(app.originating_dealer_lead_id,
                   (SELECT x.id FROM dealer_leads x WHERE x.dealer_onboarding_application_id = app.id LIMIT 1))
            UNION ALL
            SELECT acc.account_id, dl.current_owner_id, 'lead owner', 3
              FROM acc
              JOIN dealer_onboarding_applications app ON app.id = acc.app_id
              JOIN dealer_leads dl ON dl.id = COALESCE(app.originating_dealer_lead_id,
                   (SELECT x.id FROM dealer_leads x WHERE x.dealer_onboarding_application_id = app.id LIMIT 1))
        )
        SELECT DISTINCT ON (c.account_id) c.account_id, u.id::text AS user_id, u.name, c.basis
          FROM cand c
          JOIN users u ON u.id::text = c.user_id AND u.is_active IS NOT FALSE
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
>>>>>>> fac2a80905456e04c4d89ee14f26fdf80ae34f9e
}
