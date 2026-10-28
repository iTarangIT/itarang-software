/**
 * GET /api/admin/accounts/counts — the Accounts screen's tab numbers (Live,
 * No owner, GSTIN missing, Closed). Split from the list so a search, filter or
 * page change does not recount every account; the page caches this for five
 * minutes and refetches after an assignment.
 */
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ACCOUNT_ADMIN_ROLES, requireAccountTables } from "../_lib";
import { accountsTabCountsSql } from "@/lib/accounts/accountsScreen";
import { cachedAccounts } from "@/lib/accounts/accountsPage";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async () => {
    await requireRole(ACCOUNT_ADMIN_ROLES);
    await requireAccountTables();

    // ID 203: cached two minutes on the server, cleared by every write route.
    return successResponse(
        await cachedAccounts("counts", async () => {
            const res = await db.execute(await accountsTabCountsSql());
            const c = (res as unknown as Array<Record<string, unknown>>)[0] ?? {};
            return {
                total: Number(c.total ?? 0),
                no_owner: Number(c.no_owner ?? 0),
                gstin_missing: Number(c.gstin_missing ?? 0),
                closed: Number(c.closed ?? 0),
            };
        }),
    );
});
