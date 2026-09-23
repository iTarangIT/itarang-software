// GET /api/dashboard/ceo/data-health — review R-24: how much of each headline
// number is unreliable. Same roles as the CEO overview.

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { dataHealth } from "@/lib/dashboard/dataHealth";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async () => {
    await requireRole(["ceo", "admin"]);
    return successResponse({ checks: await dataHealth() });
});
