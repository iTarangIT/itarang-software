// E-390 — Battery Pool diagram 1. The dealer check as the CRM initiator sees it.
//
//   GET  → the latest check on this lead (status, dealer, reason) + the dealers
//          the initiator may re-pick from when it was rejected.
//   POST { dealer_id } → after a rejection, re-pick the dealer: the file moves
//          to it and goes back to iTarang House as a new check.
//
// Allowed for the person who started the check, and for Admin / Sales Head.

import { z } from "zod";

import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";
import { dealerDisplayNames } from "@/lib/leads/pushGuards";
import {
  DealerCheckError,
  dealerCheckKindLabel,
  eligibleDealersForStaff,
  latestDealerReview,
  resubmitDealer,
  staffUserForInitiator,
} from "@/lib/leads/dealer-assignment";

export const dynamic = "force-dynamic";

const INTERNAL = ["admin", "sales_head"];

async function loadForUser(leadId: string, user: { id: string; role: string | null }) {
  const review = await latestDealerReview(leadId);
  if (!review) return { review: null, allowed: true };
  const allowed = review.initiated_by_user_id === user.id || INTERNAL.includes(user.role ?? "");
  return { review, allowed };
}

export const GET = withErrorHandler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireAuth();
  const { id } = await params;
  const { review, allowed } = await loadForUser(id, user);
  if (!review || !allowed) return successResponse({ check: null });
  const names = await dealerDisplayNames([review.dealer_id, review.final_dealer_id ?? ""].filter(Boolean));
  let options: Array<{ dealerId: string; name: string; financeEnabled: boolean }> = [];
  if (review.status === "rejected") {
    const staff = await staffUserForInitiator({ loginUserId: user.id });
    options = (await eligibleDealersForStaff(staff)).filter((d) => d.dealerId !== review.dealer_id);
  }
  return successResponse({
    check: {
      id: review.id,
      status: review.status,
      dealer_id: review.dealer_id,
      dealer_name: names.get(review.dealer_id) ?? review.dealer_id,
      reason_label: dealerCheckKindLabel(review.reason_kind),
      decision_reason: review.decision_reason,
      decided_at: review.decided_at,
      created_at: review.created_at,
    },
    options,
  });
});

const Body = z.object({ dealer_id: z.string().trim().min(1).max(255) });

export const POST = withErrorHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireAuth();
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse("Pick a dealer", 400);
  const { review, allowed } = await loadForUser(id, user);
  if (!review || !allowed) return errorResponse("Not found", 404);
  try {
    const r = await resubmitDealer({
      leadId: id,
      dealerId: parsed.data.dealer_id,
      reviewId: review.id,
      channel: "web",
      initiator: { userId: user.id, name: user.name ?? null },
    });
    return successResponse(r);
  } catch (err) {
    if (err instanceof DealerCheckError) return errorResponse(err.message, err.status);
    throw err;
  }
});
