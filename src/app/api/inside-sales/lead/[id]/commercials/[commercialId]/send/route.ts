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
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth-utils";
import { isNextRedirectError } from "@/lib/api-utils";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import {
  dispatchQuotation,
  listDispatches,
  QUOTE_DISPATCH_CHANNELS,
} from "@/lib/leads/quoteDispatch";

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

const BodySchema = z.object({
  channels: z.array(z.enum(QUOTE_DISPATCH_CHANNELS)).min(1),
  email: z.string().trim().email().max(320).nullable().optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  message: z.string().trim().max(2000).nullable().optional(),
});

interface QuoteRow {
  commercial_id: string;
  dealer_lead_id: string;
  approval_status: string | null;
  quote_number: string | null;
  quote_pdf_url: string | null;
  quote_pdf_error: string | null;
  version_no: number;
  dealer_name: string | null;
  dealer_phone: string | null;
  dealer_email: string | null;
  // E-243 — what the dealer said back, if anything yet.
  dealer_decision: string | null;
  dealer_decision_at: string | null;
  dealer_decision_via: string | null;
  dealer_decision_note: string | null;
}

async function loadQuote(
  leadId: string,
  commercialId: string,
): Promise<QuoteRow | null> {
  const rows = await db.execute<QuoteRow>(sql`
    SELECT c.commercial_id::text AS commercial_id,
           c.dealer_lead_id, c.approval_status, c.quote_number,
           c.quote_pdf_url, c.quote_pdf_error, c.version_no,
           c.dealer_decision, c.dealer_decision_at, c.dealer_decision_via,
           c.dealer_decision_note,
           l.dealer_name, l.phone AS dealer_phone, l.contact_email AS dealer_email
      FROM dealer_lead_commercials c
      LEFT JOIN dealer_leads l ON l.id = c.dealer_lead_id
     WHERE c.commercial_id = ${commercialId}::uuid
       -- Scoped to the lead in the path: a commercial id from another lead must
       -- not be sendable by pairing it with a lead the caller can see.
       AND c.dealer_lead_id = ${leadId}
     LIMIT 1
  `);
  return (rows as unknown as QuoteRow[])[0] ?? null;
}

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
    const row = await loadQuote(id, commercialId);

    if (!row) {
      return NextResponse.json(
        { success: false, error: { message: "Quotation not found." } },
        { status: 404 },
      );
    }

    // ── The gate ────────────────────────────────────────────────────────────
    if (row.approval_status !== "approved") {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: `This quotation is ${row.approval_status ?? "undecided"} and cannot be sent to a dealer.`,
          },
        },
        { status: 409 },
      );
    }
    if (!row.quote_pdf_url || !row.quote_number) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message:
              "The quotation draft has not been generated yet. Regenerate it before sending.",
          },
        },
        { status: 409 },
      );
    }

    const email = body.email ?? row.dealer_email;
    const phone = body.phone ?? row.dealer_phone;

    const outcomes = await dispatchQuotation({
      commercialId,
      dealerLeadId: row.dealer_lead_id,
      // E-243 — signed into the approval token, so a link can only ever open
      // the exact document version the dealer was sent.
      versionNo: row.version_no,
      quoteNumber: row.quote_number,
      pdfUrl: row.quote_pdf_url,
      dealerName: row.dealer_name,
      channels: body.channels,
      email,
      phone,
      message: body.message,
      sentBy: user.id,
    });

    const sent = outcomes.filter((o) => o.status === "sent");
    const failed = outcomes.filter((o) => o.status === "failed");

    // Remember a corrected address so the next revision does not need it typed
    // again — but only when the email actually went, so a typo that bounced at
    // the provider is not saved over a working address.
    if (
      body.email &&
      body.email !== row.dealer_email &&
      sent.some((o) => o.channel === "email")
    ) {
      try {
        await db.execute(sql`
          UPDATE dealer_leads
             SET contact_email = ${body.email}, updated_at = NOW()
           WHERE id = ${row.dealer_lead_id}
        `);
      } catch (e) {
        console.error("[commercials/send] could not save dealer email", e);
      }
    }

    // One touchpoint for the send, and only when something actually went. A
    // history entry for a send where every channel failed would put a delivery
    // that never happened into the lead timeline — the same mistake E-221
    // avoided by not writing `quote_sent` on submission.
    if (sent.length) {
      await writeTouchpoint({
        dealerLeadId: row.dealer_lead_id,
        touchpointType: "quote_dispatched",
        performedBy: user.id,
        remarks:
          `Quotation ${row.quote_number} sent to dealer via ` +
          sent.map((o) => `${o.channel} (${o.recipient})`).join(", ") +
          (failed.length
            ? ` — failed on ${failed.map((o) => o.channel).join(", ")}`
            : ""),
        attachments: [{ url: row.quote_pdf_url, type: "quote" }],
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        quote_number: row.quote_number,
        outcomes,
        sent_count: sent.length,
        failed_count: failed.length,
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
