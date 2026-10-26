/**
 * GET /api/admin/accounts/suggestions?ids=A,B,C — the suggested owner for each
 * listed account (ownership.suggestedOwners). The Accounts screen asks for the
 * unowned rows on the page after the table has rendered, so the hint never
 * holds the table back. Accounts with no suggestion are left out.
 */
import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { suggestedOwners } from "@/lib/accounts/ownership";
import { ACCOUNT_ADMIN_ROLES, requireAccountTables } from "../_lib";

export const dynamic = "force-dynamic";

const MAX_IDS = 200;

const IdsSchema = z.array(z.string().trim().min(1).max(100)).max(MAX_IDS);

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(ACCOUNT_ADMIN_ROLES);
    await requireAccountTables();

    const raw = new URL(req.url).searchParams.get("ids") ?? "";
    const ids = IdsSchema.parse([...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))]);

    const map = await suggestedOwners(ids);
    return successResponse({ suggestions: Object.fromEntries(map) });
});
