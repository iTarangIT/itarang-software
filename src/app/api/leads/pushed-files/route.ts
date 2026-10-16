// ID 183 Phase 1 — GET /api/leads/pushed-files[?mobile=9876543210]
//
// Every customer file the iTarang house pushed to a dealer, with dealer,
// stage, last action and age, until disbursed or closed (lib/leads/
// pushedFiles). For the iTarang team: any house login, Admin, Sales Head.
// Admin's ?mobile= search reaches EVERY dealer's files (pushed or not).
// These files count only under their dealer — this list is not a count.

import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";
import { houseDealerCode } from "@/lib/leads/dealerByMobile";
import { isActForDealerRole } from "@/lib/leads/actForDealer";
import { listPushedFiles } from "@/lib/leads/pushedFiles";
import { isHouseLogin } from "@/lib/leads/pushToDealer";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: Request) => {
  const user = await requireAuth();
  const house = await houseDealerCode();
  const houseLogin = isHouseLogin({ role: user.role, dealerId: user.dealer_id, houseDealerCode: house });
  if (!houseLogin && !isActForDealerRole(user.role)) {
    return errorResponse("Only the iTarang team can see pushed files.", 403);
  }
  const mobile = new URL(req.url).searchParams.get("mobile");
  const files = await listPushedFiles({ mobile, acrossDealers: user.role === "admin" && !!mobile });
  return successResponse({ files, canSearchAllDealers: user.role === "admin", viewer: houseLogin ? "house" : "crm" });
});
