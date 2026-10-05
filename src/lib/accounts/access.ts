// Who may open Account management and change account owners (tracker ID 65).
// CLIENT-SAFE: no db import.

/** Admin and CEO per the spec; the Sales Head runs the team that owns the accounts. */
export const ACCOUNT_MANAGE_ROLES = ["admin", "ceo", "sales_head"] as const;

export function canManageAccounts(role: string | null | undefined): boolean {
    return (ACCOUNT_MANAGE_ROLES as readonly string[]).includes((role ?? "").toLowerCase());
}
