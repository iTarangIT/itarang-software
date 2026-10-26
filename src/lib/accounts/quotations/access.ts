/**
 * E-356 — account quotations: the presence probe and the access check, read
 * from the database. Pure rules: ../quotationAccess.ts.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getTeamMemberIds } from "@/lib/users/team";
import { hasAccountOwnershipTables } from "@/lib/accounts/tables";
import {
    ACCOUNT_QUOTE_TEAM_ROLES,
    mayCreateAccountQuote,
    mayViewAccountQuotes,
} from "@/lib/accounts/quotationAccess";

const PROBE_TTL_MS = 5 * 60_000;
let present: boolean | null = null;
let probedAt = 0;

/** E-356 applied (and E-321, which owners come from)? Same TTL idiom as ../tables.ts. */
export async function hasAccountQuotationTables(): Promise<boolean> {
    const now = Date.now();
    if (present !== null && now - probedAt < PROBE_TTL_MS) return present;
    try {
        const res = (await db.execute(sql`
            SELECT to_regclass('public.account_quotations') IS NOT NULL
               AND to_regclass('public.account_quotation_dispatches') IS NOT NULL AS ok
        `)) as unknown as Array<{ ok: boolean }>;
        present = Boolean(res[0]?.ok) && (await hasAccountOwnershipTables());
    } catch {
        present = false;
    }
    probedAt = now;
    return present;
}

/** An HTTP-status error the route wrapper (withErrorHandler) passes through. */
export class AccountQuoteError extends Error {
    readonly status: number;
    constructor(message: string, status = 409) {
        super(message);
        this.name = "AccountQuoteError";
        this.status = status;
    }
}

export type AccountSummary = {
    id: string;
    name: string;
    gstin: string | null;
    city: string | null;
    state: string | null;
    contact_name: string | null;
    contact_email: string | null;
    contact_phone: string | null;
    owner_id: string | null;
    owner_name: string | null;
};

export async function loadAccountSummary(accountId: string): Promise<AccountSummary | null> {
    const rows = (await db.execute(sql`
        SELECT a.id, a.business_entity_name AS name, a.gstin, a.city, a.state,
               a.contact_name, a.contact_email, a.contact_phone,
               ao.owner_user_id::text AS owner_id, u.name AS owner_name
          FROM accounts a
          LEFT JOIN account_ownership ao ON ao.account_id = a.id
          LEFT JOIN users u ON u.id = ao.owner_user_id
         WHERE a.id = ${accountId}
         LIMIT 1
    `)) as unknown as AccountSummary[];
    return rows[0] ?? null;
}

export type AccountQuoteAccess = { account: AccountSummary; canCreate: boolean; canView: boolean };

/**
 * Who the user is to this account's quotations. The team (direct reports) is
 * only read for an ASM — nobody else's scope widens by it.
 */
export async function accountQuoteAccess(
    user: { id: string; role: string },
    accountId: string,
): Promise<AccountQuoteAccess | null> {
    const account = await loadAccountSummary(accountId);
    if (!account) return null;
    const teamIds = (ACCOUNT_QUOTE_TEAM_ROLES as readonly string[]).includes(user.role)
        ? await getTeamMemberIds(user.id)
        : [];
    const actor = { role: user.role, userId: user.id, ownerId: account.owner_id, teamIds };
    return { account, canCreate: mayCreateAccountQuote(actor), canView: mayViewAccountQuotes(actor) };
}

/** Throw 404 / 403 unless the user may act (`create`) on or read (`view`) this account's quotations. */
export async function assertAccountQuoteAccess(
    user: { id: string; role: string },
    accountId: string,
    need: "view" | "create",
): Promise<AccountQuoteAccess> {
    if (!(await hasAccountQuotationTables())) {
        throw new AccountQuoteError("Account quotations are not set up on this server yet (E-356).", 503);
    }
    const access = await accountQuoteAccess(user, accountId);
    if (!access) throw new AccountQuoteError("Account not found.", 404);
    const ok = need === "create" ? access.canCreate : access.canView;
    if (!ok) {
        throw new AccountQuoteError(
            need === "create"
                ? "Only this account's owner (or their ASM, the Sales Head, CEO or Partner) can work its quotations."
                : "You are not assigned to this account.",
            403,
        );
    }
    return access;
}
