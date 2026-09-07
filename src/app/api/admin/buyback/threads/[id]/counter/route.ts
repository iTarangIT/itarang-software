/**
 * POST /api/admin/buyback/threads/:id/counter   (E-281, BRD M10)
 *
 * iTarang's counter-offer TO a vendor, itemized per SKU. The mirror of the
 * dealer leg's /requests/:id/counter, and the move the vendor leg has been
 * missing since Sprint 2A.
 *
 * WHY THIS IS NOT ANOTHER `kind` ON /threads/:id/record. That route is the
 * `record_*` family: an admin transcribing what a VENDOR said, hearsay,
 * faithfully recorded. This is iTarang speaking for itself — the same distinction
 * vendorActionFor draws, pointed the other way — and putting the two behind one
 * endpoint would mean one body could produce either an offer of ours or a
 * transcript of theirs depending on a string. The audit log is the whole point of
 * this module; the two acts get two URLs.
 *
 * Unscoped thread load, deliberately, exactly as /record is: an admin may counter
 * any vendor on any deal. The vendor-facing route is the one that has to prove
 * ownership.
 *
 * NO deal_line_locks write. A counter is a negotiation round. The vendor_price
 * lock is filled once, when a vendor AGREES, and this route cannot reach it.
 */

import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { requireBuybackAdmin } from "@/lib/buyback/auth";
import { applyItarangCounter } from "@/lib/buyback/vendor-response";
import { threadContextFor } from "@/lib/buyback/vendors";

export const runtime = "nodejs";

const bodySchema = z.object({
  /**
   * Per SKU, always (P5) — and every line on the quotation, which the service
   * layer enforces because it is the one with the thread's lines.
   *
   * `price`, not the dealer leg's `price_per_unit`: this is the vendor-leg
   * payload shape that /threads/:id/record and /vendor/threads/:id/respond
   * already speak, and crossing the two would be a trap for the next reader.
   */
  lines: z
    .array(
      z.object({
        line_id: z.string().uuid(),
        price: z.number().positive(),
      }),
    )
    .min(1),
  note: z.string().max(2000).optional(),
});

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: threadId } = await ctx.params;
    const actor = await requireBuybackAdmin();
    const body = bodySchema.parse(await req.json());

    const thread = await threadContextFor(threadId);

    const outcome = await db.transaction((tx) =>
      applyItarangCounter({
        tx,
        thread,
        actor: { id: actor.id, role: "admin" },
        lines: body.lines,
        note: body.note,
      }),
    );

    return successResponse({ thread_id: thread.id, ...outcome });
  },
);
