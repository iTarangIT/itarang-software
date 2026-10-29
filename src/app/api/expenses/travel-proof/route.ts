// GET /api/expenses/travel-proof?day=YYYY-MM-DD&category=Travel — tracker ID 197.
//
// The submit form's live check: the caller's own verified visits that day
// (ID 196), the verdict (Supported / Not supported) and whether the day is
// already in another pending or approved claim of this category. Only ever
// the caller's own day.

import { requireAuth } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { checkClaimDays, needsTravelProof } from "@/lib/expenses/travelProof";
import { daysAlreadyClaimed, dayEvidence, hasClaimDays } from "@/lib/expenses/travelProofStore";
import { istDay } from "@/lib/visits/verifiedCapture";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireAuth();
    const sp = new URL(req.url).searchParams;
    const day = sp.get("day") ?? "";
    const category = sp.get("category") ?? "Travel";
    if (!needsTravelProof(category)) return errorResponse("Only Travel and Vehicle/Fuel claims carry travel days.", 400);
    const check = checkClaimDays([day], istDay(new Date()));
    if (!check.ok) return errorResponse(check.message, 400);

    const enabled = await hasClaimDays();
    const [evidence, taken] = await Promise.all([
        dayEvidence(user.id, day),
        enabled ? daysAlreadyClaimed(user.id, category, [day]) : Promise.resolve([] as string[]),
    ]);
    return successResponse({ ...evidence, already_claimed: taken.includes(day), enabled });
});
