// Tracker ID 33 — GET /api/leads/dealer-lookup?mobile=9876543210
//                 GET /api/leads/dealer-lookup?q=<name or mobile>  (CRM picker)
//
// Lets the iTarang team see WHICH dealer a typed mobile belongs to before they
// submit a customer file under that dealer (Step 1 "Dealer mobile number").
// Restricted to internal roles and the house-dealer login, and it returns only
// the dealer's id and name — never the dealer's phone, email or bank details.

import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";
import { findActiveDealerByMobile, houseDealerCode, searchActiveDealers } from "@/lib/leads/dealerByMobile";
import { canUsePushToDealer, NO_ACTIVE_DEALER_MESSAGE } from "@/lib/leads/pushToDealer";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: Request) => {
  const user = await requireAuth();
  const house = await houseDealerCode();
  if (!canUsePushToDealer({ role: user.role, dealerId: user.dealer_id, houseDealerCode: house })) {
    return errorResponse("Forbidden", 403);
  }

  const sp = new URL(req.url).searchParams;

  // ID 33: ?q=<name or mobile> — the CRM "Push to dealer" picker. Approved,
  // active dealers only, at most 10; id, name and finance flag only.
  const q = sp.get("q");
  if (q !== null) {
    // ?finance=1 — the customer needs a loan: finance-enabled dealers only.
    const dealers = await searchActiveDealers(q, 10, { financeOnly: sp.get("finance") === "1" });
    return successResponse({ dealers });
  }

  const mobile = sp.get("mobile");
  // No mobile = an eligibility probe: the Step-1 form shows the "Dealer
  // mobile number" field only when this answers 200.
  if (!mobile) return successResponse({ eligible: true });

  const result = await findActiveDealerByMobile(mobile);

  switch (result.status) {
    case "found":
      return successResponse({
        found: true,
        dealer: { dealerId: result.dealer.dealerId, name: result.dealer.name },
      });
    case "invalid_mobile":
      return successResponse({ found: false, message: "Enter a 10-digit mobile number" });
    case "ambiguous":
      return successResponse({
        found: false,
        message: "More than one active dealer uses this number — ask an admin to fix the dealer records",
      });
    default:
      return successResponse({ found: false, message: NO_ACTIVE_DEALER_MESSAGE });
  }
});
