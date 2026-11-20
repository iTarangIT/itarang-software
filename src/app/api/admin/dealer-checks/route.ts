// E-390 — Battery Pool diagram 1. GET /api/admin/dealer-checks?view=pending|decided
//
// The iTarang Admin's dealer-assignment check queue (admin, sales_head).

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { listDealerReviews } from "@/lib/leads/dealer-assignment";

export const dynamic = "force-dynamic";

const DEALER_CHECK_ROLES = ["admin", "sales_head"];

export const GET = withErrorHandler(async (req: Request) => {
  await requireRole(DEALER_CHECK_ROLES);
  const view = new URL(req.url).searchParams.get("view") === "decided" ? "decided" : "pending";
  return successResponse({ view, rows: await listDealerReviews(view) });
});
