/**
 * E-243 — the dealer-facing quotation endpoint. NO SESSION REQUIRED.
 *
 *   GET  — what the approval page renders.
 *   POST — the dealer's answer.
 *
 * ## Authorisation is the token, and nothing else
 *
 * The caller is a dealer, not a user: there is no account to authenticate
 * against. The signed token IS the credential, so it is verified first and
 * everything downstream is scoped to the one quotation it names. Nothing here
 * takes an id from the request body — a body that could name a commercial_id
 * would make the signature decorative.
 *
 * ## What a dealer may see
 *
 * Deliberately narrow: their own name, the quote number, the total, and a link
 * to the document already sent to them. NOT the lead, the owner, the OEM
 * reference prices, the internal approval trail, or anything about margin. The
 * projection below is the whole allowlist — the same discipline the buyback
 * vendor quotation applies by construction.
 *
 * ## Not found and tampered are the same answer
 *
 * A bad signature, an unknown quotation and a version mismatch all return the
 * same 404. Distinguishing them would let someone probe which commercial ids
 * exist by watching the status codes change.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  DEALER_DECISIONS,
  loadQuotationForDealer,
  recordDealerDecision,
} from "@/lib/leads/quoteDecision";
import { readQuoteToken } from "@/lib/leads/quoteToken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  decision: z.enum(DEALER_DECISIONS),
  note: z.string().trim().max(1000).nullable().optional(),
});

const NOT_FOUND = {
  success: false,
  error: { message: "This quotation link is not valid or has expired." },
};

/**
 * Resolve a token to its quotation, or null.
 *
 * The version check is belt-and-braces: a revision is a new row with a new id,
 * so a token can only ever name one document. Verifying it anyway means a
 * mismatch fails closed instead of quietly answering something else.
 */
async function resolve(token: string) {
  const claims = readQuoteToken(token);
  if (!claims) return null;
  const row = await loadQuotationForDealer(claims.commercialId);
  if (!row || row.version_no !== claims.versionNo) return null;
  return row;
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await ctx.params;
    const row = await resolve(token);
    if (!row) return NextResponse.json(NOT_FOUND, { status: 404 });

    return NextResponse.json({
      success: true,
      data: {
        // No commercial_id and no lead id: the dealer never needs either, and
        // the token already carries them for the POST.
        quote_number: row.quote_number,
        dealer_name: row.dealer_name,
        value: Number(row.final_price ?? row.price_quoted ?? 0),
        pdf_url: row.quote_pdf_url,
        // Whether the page shows buttons or the answer already given.
        open:
          row.approval_status === "approved" &&
          !!row.quote_pdf_url &&
          !row.dealer_decision,
        decision: row.dealer_decision,
        decided_at: row.dealer_decision_at,
        // Only meaningful when `open` is false and no decision exists — i.e.
        // iTarang withdrew the quotation after sending it.
        withdrawn: row.approval_status !== "approved",
      },
    });
  } catch (e) {
    console.error("[public/quotations] GET failed", e);
    return NextResponse.json(
      { success: false, error: { message: "Couldn't load this quotation." } },
      { status: 500 },
    );
  }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await ctx.params;
    const claims = readQuoteToken(token);
    if (!claims) return NextResponse.json(NOT_FOUND, { status: 404 });

    const body = BodySchema.parse(await req.json());

    const row = await loadQuotationForDealer(claims.commercialId);
    if (!row || row.version_no !== claims.versionNo) {
      return NextResponse.json(NOT_FOUND, { status: 404 });
    }

    const result = await recordDealerDecision({
      commercialId: claims.commercialId,
      decision: body.decision,
      via: "link",
      // There is no identity behind a link click beyond the token itself, and
      // saying so is more honest than inventing an actor.
      actor: "token",
      note: body.note ?? null,
    });

    switch (result.outcome) {
      case "recorded":
        return NextResponse.json({
          success: true,
          data: { decision: result.decision, quote_number: result.quoteNumber, repeat: false },
        });
      case "already_answered":
        // 200, not a conflict. From the dealer's side re-opening the link and
        // seeing their own answer is the system working; an error would tell
        // them something is wrong when nothing is.
        return NextResponse.json({
          success: true,
          data: {
            decision: result.decision,
            quote_number: result.quoteNumber,
            repeat: true,
            decided_at: result.decidedAt,
          },
        });
      case "not_sendable":
        return NextResponse.json(
          { success: false, error: { message: result.reason } },
          { status: 409 },
        );
      default:
        return NextResponse.json(NOT_FOUND, { status: 404 });
    }
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: { message: "Invalid response." } },
        { status: 400 },
      );
    }
    console.error("[public/quotations] POST failed", {
      message: e instanceof Error ? e.message : String(e),
      cause: e instanceof Error && e.cause instanceof Error ? e.cause.message : undefined,
    });
    return NextResponse.json(
      { success: false, error: { message: "Couldn't record your response. Please try again." } },
      { status: 500 },
    );
  }
}
