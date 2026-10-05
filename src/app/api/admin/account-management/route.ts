// GET /api/admin/accounts — dealer accounts for Account management (ID 65):
// one row per activated dealer with its owner, "onboarded by", how it came in,
// last invoice and health bucket. Filters mirror the page's.

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ACCOUNT_MANAGE_ROLES } from "@/lib/accounts/access";
import { countAccounts, listAccounts } from "@/lib/accounts/accountList";
import { ACCOUNT_BUCKETS, type AccountBucket } from "@/lib/dealers/accountHealthRules";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole([...ACCOUNT_MANAGE_ROLES]);
    const p = new URL(req.url).searchParams;
    const bucket = p.get("bucket");
    const came = p.get("came_through");
    const [rows, counts] = await Promise.all([
        listAccounts({
            ownerId: p.get("owner") || null,
            onboardedById: p.get("onboarded_by") || null,
            cameThrough: came === "lead" || came === "direct" ? came : null,
            bucket: (ACCOUNT_BUCKETS as readonly string[]).includes(bucket ?? "") ? (bucket as AccountBucket) : null,
            dealerType: p.get("dealer_type") || null,
            noOwnerOnly: p.get("no_owner") === "1",
            gstinMissingOnly: p.get("gstin_missing") === "1",
            search: p.get("search"),
        }),
        countAccounts(),
    ]);
    return successResponse({ rows, counts });
});
