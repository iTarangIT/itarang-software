/**
 * E-242 — POST /api/inside-sales/lead/:id/commercials/:commercialId/draft
 *
 * Generate, or re-generate, the quotation document for an approved quote.
 *
 * WHY THIS EXISTS SEPARATELY FROM APPROVAL
 *   The draft is produced after the approval transaction commits, precisely so
 *   a rendering failure cannot roll back a decision. That trade needs a way
 *   back: when generation fails the row keeps `quote_pdf_error` and the sales
 *   manager is told to retry — this is the route that retry calls. Without it,
 *   the honest failure mode ("draft could not be generated") would be a dead
 *   end, and the only recovery would be re-approving a quote that is already
 *   approved.
 *
 * `force` re-renders a document that already exists, KEEPING its number. That
 * is the case where the catalogue was missing a GST rate at approval time, it
 * has since been filled in, and the document needs to be correct before it goes
 * out. The dealer-facing identity does not change; only the content does.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-utils";
import { isNextRedirectError } from "@/lib/api-utils";
import { generateQuotationDraft, QuotationDraftError } from "@/lib/leads/quoteDraft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set([
  "inside_sales_rep",
  "asm",
  "sales_manager",
  "sales_head",
  "business_head",
  "admin",
  "ceo",
]);

const BodySchema = z
  .object({ force: z.boolean().optional() })
  .nullable()
  .optional();

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; commercialId: string }> },
) {
  const { commercialId } = await ctx.params;
  try {
    const user = await requireAuth();
    if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) {
      return NextResponse.json(
        { success: false, error: { message: "FORBIDDEN" } },
        { status: 403 },
      );
    }

    // An empty body is the common case ("just make it"), so a missing or
    // unparseable body means force:false rather than a 400.
    let force = false;
    try {
      force = BodySchema.parse(await req.json())?.force ?? false;
    } catch {
      force = false;
    }

    const draft = await generateQuotationDraft(commercialId, { force });
    return NextResponse.json({ success: true, data: draft });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;

    if (e instanceof QuotationDraftError) {
      // NOT_APPROVED is the state machine refusing, not a fault — 409, and the
      // message says which state blocked it so the UI needs no lookup table.
      return NextResponse.json(
        { success: false, error: { message: e.message, code: e.code } },
        { status: e.code === "NOT_FOUND" ? 404 : 409 },
      );
    }

    console.error("[commercials/draft] failed", {
      commercialId,
      message: e instanceof Error ? e.message : String(e),
      cause: e instanceof Error && e.cause instanceof Error ? e.cause.message : undefined,
    });
    return NextResponse.json(
      {
        success: false,
        error: { message: "Couldn't generate that quotation. Please try again." },
      },
      { status: 500 },
    );
  }
}
