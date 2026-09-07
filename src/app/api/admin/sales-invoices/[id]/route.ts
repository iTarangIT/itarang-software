/**
 * E-280 — PATCH /api/admin/sales-invoices/[id]
 *
 * Clears the "needs a look" flag on an imported sales invoice. Admin-only, and
 * deliberately the only thing this route can do: the figures on these rows come
 * off the invoice PDF and belong to the document, not to whoever is triaging.
 *
 * Why it exists: the scanner sets `needs_attention` and nothing has ever been
 * able to unset it. A re-scan will not, because an already-imported file is
 * settled and never re-read. So the attention panel could only grow, and a list
 * that cannot be emptied stops being read at all.
 *
 * WHY THE REASON IS KEPT
 *   The expense twin (api/admin/ai-expenses/[id]) nulls attention_reason when
 *   the flag is cleared. Here the reason is the only record of what the scanner
 *   saw — /ceo/invoices still surfaces it, and "a human checked this" is a
 *   different fact from "there was never anything to check". So the flag comes
 *   down and the reason stays.
 *
 * Sits beside the drive/ segment: Next.js matches the static segment first, so
 * /api/admin/sales-invoices/drive/* is unaffected by this dynamic route.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { salesInvoices } from "@/lib/db/schema";
import { requireApiAdmin } from "@/lib/auth/requireApiAdmin";
import { isNextRedirectError, errorMessage } from "@/lib/api-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  /** Only false is meaningful — nothing should be able to raise a flag by hand. */
  needs_attention: z.literal(false),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requireApiAdmin();
    if (!guard.ok) return guard.response;

    const { id } = await ctx.params;
    if (!z.string().uuid().safeParse(id).success) {
      return NextResponse.json(
        { success: false, error: { message: "Not a valid invoice id" } },
        { status: 400 },
      );
    }

    const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: { message: "Validation failed" } },
        { status: 400 },
      );
    }

    const [updated] = await db
      .update(salesInvoices)
      .set({ needs_attention: false, updated_at: new Date() })
      .where(eq(salesInvoices.id, id))
      .returning({ id: salesInvoices.id, invoice_number: salesInvoices.invoice_number });

    if (!updated) {
      return NextResponse.json(
        { success: false, error: { message: "No such invoice." } },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, data: updated });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    const msg = errorMessage(e);
    console.error("[admin/sales-invoices/[id]] error:", msg);
    return NextResponse.json({ success: false, error: { message: msg } }, { status: 500 });
  }
}
