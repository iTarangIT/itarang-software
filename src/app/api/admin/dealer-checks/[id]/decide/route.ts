// E-390 — Battery Pool diagram 1. POST /api/admin/dealer-checks/[id]/decide
//   body { decision: "approve" | "change" | "reject", dealer_id?, reason? }
//
// Approve → the file may go to a lender. Change → the file moves to the dealer
// picked here, then may go to a lender. Reject (reason required) → the
// initiator is told and picks again.

import { z } from "zod";

import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { DealerCheckError, decideDealerReview } from "@/lib/leads/dealer-assignment";

export const dynamic = "force-dynamic";

const Body = z.object({
  decision: z.enum(["approve", "change", "reject"]),
  dealer_id: z.string().trim().max(255).optional().nullable(),
  reason: z.string().trim().max(1000).optional().nullable(),
});

export const POST = withErrorHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireRole(["admin", "sales_head"]);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? "Invalid request", 400);
  const { id } = await params;
  try {
    const result = await decideDealerReview({
      reviewId: id,
      actor: { id: user.id, name: user.name ?? null, role: user.role ?? null },
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
