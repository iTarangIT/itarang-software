/**
 * POST /api/admin/buyback/catalog/review — "I have looked at these prices" (M16)
 *
 * The nudge in checkPriceReviewDue() is only as good as the thing that silences
 * it. Without a recorded review the banner is permanent, and a permanent banner
 * is wallpaper — read by nobody, and so worth nothing when prices really have
 * gone stale. This is the button that resets the clock.
 *
 * A review is an APPEND, not a flag: catalog_price_reviews keeps every one, so
 * "when did we last check, and who says so?" stays answerable months later.
 */

import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireBuybackAdmin } from "@/lib/buyback/auth";
import { recordReview } from "@/lib/buyback/catalog";

export const runtime = "nodejs";

const bodySchema = z.object({
  note: z.string().max(500).optional(),
});

export const POST = withErrorHandler(async (req: Request) => {
  const actor = await requireBuybackAdmin();

  // The note is optional, so a bodyless POST is legitimate — don't 500 on it.
  const raw = await req.json().catch(() => ({}));
  const body = bodySchema.parse(raw ?? {});

  await recordReview(actor.id, body.note);

  return successResponse({ ok: true });
});
