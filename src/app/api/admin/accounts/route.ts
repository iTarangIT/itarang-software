/**
 * GET /api/admin/accounts — the Accounts tab (tracker P1-1 / P1-2).
 *
 * Every dealer account with its current owner, who onboarded it, whether it
 * came through a lead or a direct onboarding, and a "GSTIN missing" flag.
 * Unowned rows carry a SUGGESTED owner — a hint only; a person assigns it
 * from the page. For speed it is NOT computed here: the page fetches it from
 * ./suggestions once the rows are on screen, and the tab numbers from
 * ./counts (they never depend on the filters). SQL: lib/accounts/accountsScreen;
 * the list itself: lib/accounts/accountsPage (shared with the page's first load).
 *
 * Query: q, owner=<uuid>|none, gstin_missing=1, came_through=lead|direct,
 *        status, limit (≤ 500, default 100), offset.
 */
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ACCOUNT_ADMIN_ROLES, requireAccountTables } from "./_lib";
import { AccountsListQuerySchema, listAccountsPage } from "@/lib/accounts/accountsPage";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(ACCOUNT_ADMIN_ROLES);
    await requireAccountTables();

    const params = Object.fromEntries(
        [...new URL(req.url).searchParams.entries()].filter(([, v]) => v !== ""),
    );
    return successResponse(await listAccountsPage(AccountsListQuerySchema.parse(params)));
});
