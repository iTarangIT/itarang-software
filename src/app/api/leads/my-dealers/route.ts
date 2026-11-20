// E-390 — Battery Pool diagram 1. GET /api/leads/my-dealers[?finance=1]
//
// The dealers the iTarang sales person behind this login owns (Account
// ownership), for the CRM Step 1 "Dealer" picker. The login must be an iTarang
// House team login (or Admin / Sales Head); the link login → sales person is
// set by the admin on House team logins (house_login_staff_links).
// Returns id, name and finance flag only.

import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";
import { houseDealerCode } from "@/lib/leads/dealerByMobile";
import { eligibleDealersForStaff, pickOutcome, staffUserForInitiator } from "@/lib/leads/dealer-assignment";
import { canUsePushToDealer } from "@/lib/leads/pushToDealer";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: Request) => {
  const user = await requireAuth();
  const house = await houseDealerCode();
  if (!canUsePushToDealer({ role: user.role, dealerId: user.dealer_id, houseDealerCode: house })) {
    return errorResponse("Forbidden", 403);
  }
  const financeOnly = new URL(req.url).searchParams.get("finance") === "1";
  const staff = await staffUserForInitiator({ loginUserId: user.id });
  const dealers = await eligibleDealersForStaff(staff, { financeOnly });
  return successResponse({ linked: !!staff, dealers, outcome: pickOutcome(dealers.length) });
});
