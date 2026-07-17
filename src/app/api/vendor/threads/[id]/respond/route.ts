/**
 * POST /api/vendor/threads/:id/respond   (E-195, BRD M24)
 *
 * A vendor answering their own quotation, first-hand:
 *
 *   counter — per-line prices           → VENDOR_NEGOTIATING
 *   agree   — accept the standing ask   → VENDOR_AGREED
 *   decline — walk away                 → thread LOST, deal unmoved
 *
 * The mirror of POST /api/admin/buyback/threads/:id/record, and deliberately
 * the same rules: both delegate to applyVendorResponse, so the floor guard,
 * first-AGREED-wins, the fill-once lock write and the courteous close exist
 * once. The only difference is the actor — which decides whether the audit
 * trail records testimony or hearsay.
 *
 * THE AUTHORISATION IS THE POINT OF THIS FILE. The admin route proves staff;
 * this one must prove the thread is the CALLER'S. loadOwnThread scopes by the
 * vendor's own accounts.id in the query, and a miss is a 404 — never a 403. A
 * 403 would confirm the thread exists, and a vendor who can enumerate thread
 * ids can map our deal flow and discover which lots exist that they were not
 * offered.
 *
 * A vendor may NOT set an arbitrary price on an agree. `lines` is accepted for
 * a counter only. On the admin path an override exists because a human is
 * transcribing a negotiated figure; letting the vendor supply one here would
 * let them "agree" at a number nobody offered them — the standing price (their
 * own counter, or our ask) is what agreeing means.
 */

import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { requireVendor } from "@/lib/buyback/auth";
import { NotFoundError } from "@/lib/buyback/errors";
import { applyVendorResponse, type VendorThreadContext } from "@/lib/buyback/vendor-response";
import { loadOwnThread, threadContextFor } from "@/lib/buyback/vendors";

export const runtime = "nodejs";

const bodySchema = z.object({
  // "decline", not "reject": the vendor is declining our offer. `reject` is the
  // admin's word for the same outcome, and reads oddly in the first person.
  kind: z.enum(["counter", "agree", "decline"]),
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
    const actor = await requireVendor();
    const body = bodySchema.parse(await req.json());

    // Ownership, scoped in the query. Not "load then check".
    const own = await loadOwnThread(actor.entityId!, threadId);
    if (!own) throw new NotFoundError("Quotation not found.");

    const thread: VendorThreadContext = await threadContextFor(threadId);

    const outcome = await db.transaction((tx) =>
      applyVendorResponse({
        tx,
        thread,
        actor: { id: actor.id, role: "vendor" },
        kind: body.kind === "decline" ? "reject" : body.kind,
        // An agree takes the standing prices; only a counter names new ones.
        lines: body.kind === "counter" ? body.lines : undefined,
        note: body.note,
      }),
    );

    // The vendor gets back their own outcome and nothing about the rest of the
    // deal — no floor, no losing vendors, no dealer-side status. applyVendorResponse
    // returns those for the admin screen; they are not this caller's business.
    return successResponse({
      thread_id: thread.id,
      thread_status: outcome.thread_status,
      round_no: outcome.round_no,
      agreed_total: outcome.agreed_total,
    });
  },
);
