// GET /api/admin/dealer-health?group=owner|city|business_type — converted
// dealers' account health (review R-18): every converted dealer with its
// bucket, plus the Section C summary with reorder rate.

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { listDealerHealth, summarizeDealerHealth } from "@/lib/dealers/accountHealth";

export const dynamic = "force-dynamic";

const VIEW_ROLES = ["admin", "ceo", "sales_head", "business_head", "partner"];

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(VIEW_ROLES);
    const g = new URL(req.url).searchParams.get("group");
    const group = g === "city" || g === "business_type" ? g : "owner";
    const [rows, summary] = await Promise.all([listDealerHealth(), summarizeDealerHealth(group)]);
    return successResponse({ rows, summary, group });
});
