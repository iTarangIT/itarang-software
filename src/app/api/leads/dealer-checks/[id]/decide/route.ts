// E-390 — Battery Pool diagram 1. POST /api/leads/dealer-checks/[id]/decide
//   body { decision: "approve" | "change" | "reject", dealer_id?, reason? }
//
// Who may decide: the main iTarang House login, house team logins marked
// "Can approve", and the people on Settings › Dealer check alerts (23 Nov).
// The decision is recorded against the person's own user id and name.
// Approve / Change → the file goes on to the Admin / Sales Head KYC review and
// may go to a lender. Reject (reason required) → the initiator picks again.

import { z } from "zod";

import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";
import { DealerCheckError, decideDealerReview, mayDecideDealerChecks } from "@/lib/leads/dealer-assignment";

export const dynamic = "force-dynamic";

const Body = z.object({
  decision: z.enum(["approve", "change", "reject"]),
  dealer_id: z.string().trim().max(255).optional().nullable(),
  reason: z.string().trim().max(1000).optional().nullable(),
});

export const POST = withErrorHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireAuth();
  if (!(await mayDecideDealerChecks(user))) {
    return errorResponse("You are not authorised to approve, change or reject a dealer. Ask the Sales Head to give your login approval rights.", 403);
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? "Invalid request", 400);
  const { id } = await params;
  try {
    const result = await decideDealerReview({
      reviewId: id,
      actor: { id: user.id, name: user.name ?? null, role: user.role ?? null, via: "crm" },
      decision: parsed.data.decision,
      newDealerId: parsed.data.dealer_id ?? null,
      reason: parsed.data.reason ?? null,
    });
    return successResponse(result);
  } catch (err) {
    if (err instanceof DealerCheckError) return errorResponse(err.message, err.status);
    throw err;
  }
});
