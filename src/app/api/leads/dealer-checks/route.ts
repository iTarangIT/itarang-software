// E-390 — Battery Pool diagram 1. GET /api/leads/dealer-checks?view=pending|decided
//
// The dealer-assignment check queue. Decided by the iTarang House dealer
// logins (20 Nov); Admin / Sales Head may read it (view only).

import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";
import { listDealerReviews, mayDecideDealerChecks } from "@/lib/leads/dealer-assignment";

export const dynamic = "force-dynamic";

const VIEW_ONLY_ROLES = ["admin", "sales_head"];

export const GET = withErrorHandler(async (req: Request) => {
  const user = await requireAuth();
  const canDecide = await mayDecideDealerChecks(user);
  if (!canDecide && !VIEW_ONLY_ROLES.includes(user.role ?? "")) {
    return errorResponse("Only iTarang House can see the dealer checks.", 403);
  }
  const view = new URL(req.url).searchParams.get("view") === "decided" ? "decided" : "pending";
  return successResponse({ view, canDecide, rows: await listDealerReviews(view) });
});
