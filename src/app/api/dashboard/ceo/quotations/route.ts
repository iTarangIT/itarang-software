/**
 * E-221 — GET /api/dashboard/ceo/quotations
 *
 * The CEO's pending-quotation queue. Every quote_issue / quote_revision waits
 * here before it may be sent to a dealer.
 *
 * Returns the quote's value, who raised it, which dealer it is for and how long
 * it has waited — the four things needed to decide without opening the lead.
 * The quote document, when one was attached, comes along so it can be read
 * before approving.
 */
import { NextResponse } from "next/server";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerLeadCommercials, dealerLeads, users } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["ceo", "admin"]);

/** Enough to work through a queue; beyond this the panel is the wrong tool. */
const CAP = 100;

export async function GET() {
  try {
    const user = await requireAuth();
    if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) {
      return NextResponse.json(
        { success: false, error: { message: "FORBIDDEN" } },
        { status: 403 },
      );
    }

    const rows = await db
      .select({
        commercial_id: dealerLeadCommercials.commercial_id,
        dealer_lead_id: dealerLeadCommercials.dealer_lead_id,
        version_no: dealerLeadCommercials.version_no,
        event_type: dealerLeadCommercials.event_type,
        price_quoted: dealerLeadCommercials.price_quoted,
        final_price: dealerLeadCommercials.final_price,
        quote_document_url: dealerLeadCommercials.quote_document_url,
        product_lines: dealerLeadCommercials.product_lines,
        created_at: dealerLeadCommercials.created_at,
        raised_by: users.name,
        dealer_name: dealerLeads.dealer_name,
        city: dealerLeads.city,
      })
      .from(dealerLeadCommercials)
      .leftJoin(dealerLeads, eq(dealerLeads.id, dealerLeadCommercials.dealer_lead_id))
      // created_by is text and users.id is uuid — cast the uuid, never the text,
      // so a non-uuid created_by cannot raise invalid_text_representation and
      // take the whole queue down.
      .leftJoin(users, sql`${users.id}::text = ${dealerLeadCommercials.created_by}`)
      .where(eq(dealerLeadCommercials.approval_status, "pending"))
      // Oldest first: the queue is worked front to back, and the thing that has
      // waited longest is the thing blocking a rep.
      .orderBy(asc(dealerLeadCommercials.created_at))
      .limit(CAP);

    const [countRow] = await db
      .select({ n: sql<number>`COUNT(*)` })
      .from(dealerLeadCommercials)
      .where(eq(dealerLeadCommercials.approval_status, "pending"));

    return NextResponse.json({
      success: true,
      data: {
        // The true pending count, which can exceed the rows returned — the
        // panel must not imply the queue is shorter than it is.
        total: Number(countRow?.n || 0),
        capped: Number(countRow?.n || 0) > CAP,
        quotations: rows.map((r) => ({
          commercial_id: r.commercial_id,
          dealer_lead_id: r.dealer_lead_id,
          version_no: r.version_no,
          event_type: r.event_type,
          // final_price is the product roll-up and wins when present; the two
          // disagree on revisions where only lines changed.
          value: Number(r.final_price ?? r.price_quoted ?? 0),
          quote_document_url: r.quote_document_url,
          line_count: Array.isArray(r.product_lines) ? r.product_lines.length : 0,
          raised_by: r.raised_by ?? "(unknown)",
          dealer_name: r.dealer_name ?? "(unnamed lead)",
          city: r.city,
          created_at: r.created_at,
        })),
      },
    });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    return NextResponse.json(
      { success: false, error: { message: errorMessage(e) } },
      { status: 500 },
    );
  }
}
