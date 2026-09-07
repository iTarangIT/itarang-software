/**
 * POST /api/admin/buyback/threads/:id/accept-counter   (E-281, BRD M10)
 *
 * iTarang accepting a vendor's standing counter. The mirror of the dealer leg's
 * /requests/:id/accept-counter, and the "yes" the desk previously lacked: before
 * this the only way to close a vendor negotiation from the admin side was
 * `record_vendor_agreement`, which claims in the audit log that the VENDOR said
 * yes. They had not; we had.
 *
 * NO BODY. Accepting means accepting the number already on the table — the
 * service layer resolves it through standingPriceSql and ignores any override.
 * Naming a different figure is a counter, and has its own route. This is also
 * what stops an admin booking an "agreement" at a price no vendor ever offered.
 *
 * Everything else — the floor guard, first-AGREED-wins via the partial unique
 * index, the fill-once vendor_price write, the courteous close to the losing
 * vendors — is applyVendorResponse's AGREE branch, unchanged and shared.
 */

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { requireBuybackAdmin } from "@/lib/buyback/auth";
import { applyVendorResponse } from "@/lib/buyback/vendor-response";
import { threadContextFor } from "@/lib/buyback/vendors";

export const runtime = "nodejs";

export const POST = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: threadId } = await ctx.params;
    const actor = await requireBuybackAdmin();

    const thread = await threadContextFor(threadId);

    const outcome = await db.transaction((tx) =>
      applyVendorResponse({
        tx,
        thread,
        actor: { id: actor.id, role: "admin" },
        kind: "accept_counter",
      }),
    );

    return successResponse({ thread_id: thread.id, ...outcome });
  },
);
