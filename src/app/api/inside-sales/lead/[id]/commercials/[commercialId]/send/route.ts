/**
 * E-242 — POST/GET /api/inside-sales/lead/:id/commercials/:commercialId/send
 *
 * POST sends an approved quotation to the dealer over WhatsApp and/or email.
 * GET returns what the send dialog needs to open: the draft, the prefilled
 * recipients, and every previous attempt.
 *
 * ## The guard IS the state machine
 *
 * §4 of docs/quotation-approval-flow.md: "a quote cannot be sent to a dealer
 * without having passed the gate". That is enforced here, not in the UI — the
 * route refuses anything whose `approval_status` is not 'approved' and anything
 * with no generated document. A pending quote has no `quote_pdf_url` because
 * generateQuotationDraft refuses to produce one, so the two checks agree by
 * construction rather than by both being remembered.
 *
 * ## Why sales_manager is allowed here but cannot raise a quote
 *
 * The commercials route's MUTATE_ROLES is inside_sales_rep / asm / admin, and
 * that stays as it is — raising a quote is the rep's job. Sending an approved
 * one is the sales manager's, per the requirement, so this route has its own
 * wider role set. Ownership is NOT asserted: a sales manager sending a quote for
 * a lead they do not own is the entire point of notifying them.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-utils";
import { isNextRedirectError } from "@/lib/api-utils";
import { listDispatches, QUOTE_DISPATCH_CHANNELS } from "@/lib/leads/quoteDispatch";
import { MAX_EXTRA_CC, resolveQuotationCc } from "@/lib/leads/quotationCc";
import {
  loadQuote,
  QuotationNotSendableError,
  sendApprovedQuotation,
} from "@/lib/leads/sendQuotation";

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
  "partner",
]);

const BodySchema = z.object({
  channels: z.array(z.enum(QUOTE_DISPATCH_CHANNELS)).min(1),
  email: z.string().trim().email().max(320).nullable().optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  message: z.string().trim().max(2000).nullable().optional(),
  // E-297 — one-off CC addresses typed into the dialog, on top of the
  // server-resolved owner / approver / admin fixed list.
  extraCc: z
    .array(z.string().trim().email("Each extra CC must be a valid email.").max(320))
    .max(MAX_EXTRA_CC, `At most ${MAX_EXTRA_CC} extra CC addresses.`)
    .optional(),
});

function forbidden() {
  return NextResponse.json(
    { success: false, error: { message: "FORBIDDEN" } },
    { status: 403 },
  );
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; commercialId: string }> },
) {
  try {
    const user = await requireAuth();
    if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) return forbidden();

    const { id, commercialId } = await ctx.params;
    const row = await loadQuote(id, commercialId);
    if (!row) {
      return NextResponse.json(
        { success: false, error: { message: "Quotation not found." } },
        { status: 404 },
      );
    }

    // E-297 — who the email will be CC'd to, so the dialog can show it before
    // sending. Never throws; resolves to an empty list on any failure. The
    // actor is the viewer: whoever opens the dialog is who will press Send.
    const cc = await resolveQuotationCc(id, commercialId, { actorId: user.id });

    return NextResponse.json({
      success: true,
      data: {
        commercial_id: row.commercial_id,
        version_no: row.version_no,
        approval_status: row.approval_status,
        quote_number: row.quote_number,
        quote_pdf_url: row.quote_pdf_url,
        quote_pdf_error: row.quote_pdf_error,
        // Whether the dialog may enable its Send button at all.
        sendable: row.approval_status === "approved" && !!row.quote_pdf_url,
        dealer_name: row.dealer_name,
        // Prefills. Both are editable, and a corrected email is written back on
        // a successful send.
        email: row.dealer_email,
        phone: row.dealer_phone,
        // E-243 — the dealer's answer, so the dialog can show it instead of
        // inviting a resend to somebody who has already replied.
        dealer_decision: row.dealer_decision,
        dealer_decision_at: row.dealer_decision_at,
        dealer_decision_via: row.dealer_decision_via,
        dealer_decision_note: row.dealer_decision_note,
        cc_preview: {
          cc: cc.cc,
          owner_email: cc.ownerEmail,
          actor_email: cc.actorEmail,
          fixed: cc.fixed,
        },
        dispatches: await listDispatches(commercialId),
      },
    });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    console.error("[commercials/send] GET failed", e);
    return NextResponse.json(
      { success: false, error: { message: "Couldn't load this quotation." } },
      { status: 500 },
    );
  }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; commercialId: string }> },
) {
  const { id, commercialId } = await ctx.params;
  try {
    const user = await requireAuth();
    if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) return forbidden();

    const body = BodySchema.parse(await req.json());
    // The gate, the send, the email write-back and the touchpoint all live in
    // sendApprovedQuotation — shared with the WhatsApp Assistant's send_quote.
    let result;
    try {
      result = await sendApprovedQuotation({
        leadId: id,
        commercialId,
        channels: body.channels,
        email: body.email,
        phone: body.phone,
        message: body.message,
        extraCc: body.extraCc ?? [],
        actor: { id: user.id, name: user.name ?? null },
      });
    } catch (e) {
      if (e instanceof QuotationNotSendableError) {
        return NextResponse.json(
          { success: false, error: { message: e.message } },
          { status: e.reason === "not_found" ? 404 : 409 },
        );
      }
      throw e;
    }

    return NextResponse.json({
      success: true,
      data: {
        quote_number: result.quote_number,
        outcomes: result.outcomes,
        sent_count: result.sent_count,
        failed_count: result.failed_count,
      },
      // 200 even on a partial send: the successful channel is a fact the caller
      // must not be able to mistake for a total failure and retry blindly.
    });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        {
          success: false,
          error: { message: e.issues[0]?.message ?? "Invalid request body." },
        },
        { status: 400 },
      );
    }
    console.error("[commercials/send] failed", {
      commercialId,
      message: e instanceof Error ? e.message : String(e),
      cause: e instanceof Error && e.cause instanceof Error ? e.cause.message : undefined,
    });
    return NextResponse.json(
      { success: false, error: { message: "Couldn't send that quotation. Please try again." } },
      { status: 500 },
    );
  }
}
