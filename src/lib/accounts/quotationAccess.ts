/**
 * E-358 — who may raise and work an ACCOUNT quotation. CLIENT-SAFE, pure (no
 * db import). The DB wrapper is canQuoteAccount in ./quotations/access.ts.
 *
 * 24 Oct meeting (Kartik, items 8 + 11), decided by the user:
 *   - ISR / ASM: the accounts they own (account_ownership.owner_user_id).
 *   - ASM also: accounts owned by a direct report (e.g. Sonu's associates).
 *   - Sales Head, CEO, Partner: any account.
 *   - Admin: sees and approves, but is NOT a quotation creator — the account
 *     owner follows the business process.
 * Anyone else, or an owner role on someone else's account, is refused.
 */

export const ACCOUNT_QUOTE_ANY_ROLES = ["sales_head", "ceo", "partner"] as const;
export const ACCOUNT_QUOTE_OWNER_ROLES = ["inside_sales_rep", "asm"] as const;
/** Roles whose own team (direct reports) widens what they may quote. */
export const ACCOUNT_QUOTE_TEAM_ROLES = ["asm"] as const;
/** Everyone who may open an account's quotations at all. */
export const ACCOUNT_QUOTE_VIEW_ROLES = [...ACCOUNT_QUOTE_ANY_ROLES, ...ACCOUNT_QUOTE_OWNER_ROLES, "admin"] as const;

const has = (list: readonly string[], role: string | null | undefined) => !!role && list.includes(role);

export type AccountQuoteActor = {
    role: string | null | undefined;
    userId: string | null | undefined;
    /** The account's current owner, or null when it has none. */
    ownerId: string | null | undefined;
    /** The actor's direct reports (only read for ACCOUNT_QUOTE_TEAM_ROLES). */
    teamIds?: readonly string[] | null;
};

/** Is this account inside the actor's scope (any-role, owner, or their team's)? */
export function accountInQuoteScope(a: AccountQuoteActor): boolean {
    if (has(ACCOUNT_QUOTE_ANY_ROLES, a.role)) return true;
    if (!has(ACCOUNT_QUOTE_OWNER_ROLES, a.role) || !a.userId || !a.ownerId) return false;
    if (a.ownerId === a.userId) return true;
    return has(ACCOUNT_QUOTE_TEAM_ROLES, a.role) && (a.teamIds ?? []).includes(a.ownerId);
}

/** May the actor raise (or revise / send / withdraw) a quotation on this account? */
export function mayCreateAccountQuote(a: AccountQuoteActor): boolean {
    return accountInQuoteScope(a);
}

/** May the actor read this account's quotations? Admin reads every account. */
export function mayViewAccountQuotes(a: AccountQuoteActor): boolean {
    return a.role === "admin" || accountInQuoteScope(a);
}

/** Which slice of accounts My Dealers lists for this role. */
export function myDealersScope(role: string | null | undefined): "all" | "team" | "own" {
    if (has(ACCOUNT_QUOTE_ANY_ROLES, role)) return "all";
    if (has(ACCOUNT_QUOTE_TEAM_ROLES, role)) return "team";
    return "own";
}
