/**
 * POST /api/admin/buyback/threads/:id/record   (BRD M10)
 *
 * Records what a vendor said, PER SKU. Three kinds:
 *
 *   counter — they came back with per-line prices  → VENDOR_NEGOTIATING
 *   agree   — they accepted (at our ask, or at their own counter) → VENDOR_AGREED
 *   reject  — they are out                          → thread LOST, deal unmoved
 *
 * An admin typing in what arrived by email. That is why every one of these is
 * an admin action, and why the state machine calls them `record_*`: this is
 * hearsay, faithfully recorded.
 *
 * It is no longer the ONLY way a vendor's answer can arrive. E-195 gave vendors
 * a login, so the same three moves also come first-hand through
 * POST /api/vendor/threads/:id/respond. Both routes are thin — auth, parse,
 * delegate — and the rules they share (the floor, first-AGREED-wins, the
 * fill-once lock write, the courteous close) live in ONE place:
 * src/lib/buyback/vendor-response.ts. This route used to hold all of it inline;
 * copying it for the vendor path would have meant two floor guards, and the
 * second one to drift is the one that sells a lot below cost.
 *
 * This path stays regardless of the portal: a vendor who replies to the
 * quotation email rather than logging in still needs an admin to record it.
 */

import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { requireBuybackAdmin } from "@/lib/buyback/auth";
import { applyVendorResponse } from "@/lib/buyback/vendor-response";
import { threadContextFor } from "@/lib/buyback/vendors";

export const runtime = "nodejs";

const bodySchema = z.object({
  kind: z.enum(["counter", "agree", "reject"]),
  /** Per-SKU, always. Required for a counter; optional for an agree (defaults to the standing prices). */
  lines: z
    .array(
      z.object({
        line_id: z.string().uuid(),
        price: z.number().positive(),
      }),
    )
    .optional(),
  note: z.string().max(2000).optional(),
});

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: threadId } = await ctx.params;
    const actor = await requireBuybackAdmin();
    const body = bodySchema.parse(await req.json());

    // Unscoped, and that is correct here — an admin may record for any vendor.
    // The vendor route calls loadOwnThread first; see its docblock.
    const thread = await threadContextFor(threadId);

    const outcome = await db.transaction((tx) =>
      applyVendorResponse({
        tx,
        thread,
        // 'admin' is not a formality: it is what makes the audit row say this
        // was recorded on the vendor's behalf rather than said by them.
        actor: { id: actor.id, role: "admin" },
        kind: body.kind,
        lines: body.lines,
        note: body.note,
      }),
    );

    return successResponse({ thread_id: thread.id, ...outcome });
  },
);
