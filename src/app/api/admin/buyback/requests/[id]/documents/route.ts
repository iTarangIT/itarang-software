/**
 * GET /api/admin/buyback/requests/:id/documents   (M15 — the document centre)
 *
 * Every document a deal produces, in one place, with its DIRECTION — who issued
 * it to whom. That direction matrix is the point: on a back-to-back trade the same
 * word ("invoice") means two opposite things depending on which leg you are
 * standing on, and an auditor asked to reconstruct the deal needs to be told which
 * is which.
 *
 * M15's AC is "every CLOSED deal has the full set", so this endpoint does not just
 * list what exists — it reports what is MISSING, and whether the set is complete.
 * A document centre that only shows you the documents you have is exactly no help
 * for the question you actually have, which is "what am I missing?".
 *
 * NOTE — M15 appears in no sprint row of the BRD's §9 table. It was simply left
 * out of the plan. It is built here because the Sprint 2 exit criteria depend on
 * it (a CLOSED deal must be provably complete) and because every document it lists
 * already exists and is keyed; without this they are simply unreachable.
 *
 * The per-deal fan-out itself now lives in `@/lib/buyback/documents`
 * (`buildDealDocumentSet`) so the documents-by-dealer view can reuse it — the
 * response is byte-identical to before that extraction. This route stays the
 * resolver: request id → deal → the shared builder → the same envelope.
 */

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { loadAnyRequest, requireBuybackAdmin } from "@/lib/buyback/auth";
import { NotFoundError } from "@/lib/buyback/errors";
import { dealHeader } from "@/lib/buyback/queries";
import { buildDealDocumentSet } from "@/lib/buyback/documents";

export const runtime = "nodejs";

export const GET = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    await requireBuybackAdmin();
    const request = await loadAnyRequest(requestId);

    const header = await dealHeader(request.id);
    if (!header) throw new NotFoundError("Deal not found.");

    return successResponse(await buildDealDocumentSet(header.deal_id));
  },
);
