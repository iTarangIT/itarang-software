/**
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
    return rows;
}

/**
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
}
