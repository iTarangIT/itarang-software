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
 *
 * E-226 — and now WHY it is here. Since auto-approval releases everything at or
 * above the OEM reference price, a quote reaching this queue always failed a
 * specific check, so the queue carries that check's verdict: which lines are
 * short, by how much, and against which reference price. Without it the CEO is
 * asked to approve a number with no stated benchmark, which is the decision the
 * price book was built to inform.
 *
 * E-230 — `?status=approved` returns what has ALREADY been released.
 *
 * Auto-approval created a blind spot: before it, every quote passed through the
 * CEO's hands, so the pending queue was also the record of everything that went
 * out. Now the quotes that clear the reference price release themselves and
 * appear in no CEO-facing screen at all. This answers "what went out in my name
 * this week, and at what margin" — which is the question the price book makes
 * askable and, until now, left unanswered.
 *
 * Default stays `pending`, so every existing caller is unaffected.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { dealerLeadCommercials, dealerLeads, users } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";
import { GATED_QUOTE_EVENTS } from "@/lib/leads/quoteApproval";
import { linesNeedingAttention, type OemEvaluation } from "@/lib/leads/oemPricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["ceo", "admin"]);

/** Enough to work through a queue; beyond this the panel is the wrong tool. */
const CAP = 100;

/** The approver, joined separately from the rep who raised the quote. */
const approver = alias(users, "approver");

/**
 * The value of a quote: the product roll-up wins where present, because the two
 * disagree on a revision that changed only lines.
 */
const quoteValue = sql<number>`COALESCE(${dealerLeadCommercials.final_price},
                                        ${dealerLeadCommercials.price_quoted}, 0)`;

/**
 * When a quote was decided, for ordering the released list.
 *
 * COALESCE because `approved_at` is not universal: auto-approval stamps it and
 * the decision route stamps it, but rows written before E-221 were defaulted to
 * 'approved' by the schema and never had a decision moment at all. Ordering on
 * the bare column would bury those at one end regardless of age.
 */
const decidedAt = sql`COALESCE(${dealerLeadCommercials.approved_at},
                               ${dealerLeadCommercials.created_at})`;

/**
 * How this quote came to be approved — 'auto', 'manual', or null for a row that
 * predates the distinction.
 *
 * `approval_mode` is the direct answer where it exists, but it arrived with
 * E-226; a quote the CEO approved by hand before that has mode NULL and
 * `approved_by` set, and reading it as "auto" would credit the machine with a
 * decision a person made. Derived here rather than in the panel so both halves
 * cannot drift.
 */
function approvalRoute(
  mode: string | null,
  approvedBy: string | null,
): "auto" | "manual" | null {
  if (mode === "auto" || mode === "manual") return mode;
  return approvedBy ? "manual" : null;
}

/**
 * The price check, trimmed to what the panel renders.
 *
 * Returns null for a quote raised before E-226, and for one whose evaluation is
 * not the shape we expect. The panel then shows the row exactly as it did
 * before — a queue that refuses to render a legacy row would be worse than one
 * that renders it without the new detail.
 */
function summariseEvaluation(raw: unknown) {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Partial<OemEvaluation>;
  if (!Array.isArray(e.lines) || typeof e.reason !== "string") return null;
  return {
    reason: e.reason,
    shortfall_total: Number(e.shortfall_total ?? 0),
    lines_flagged: linesNeedingAttention(e as OemEvaluation),
    lines: e.lines.map((l) => ({
      product_name: l.product_name,
      asset_type: l.asset_type,
      quantity: l.quantity,
      quoted_unit_price: l.quoted_unit_price,
      oem_price: l.oem_price,
      delta: l.delta,
      status: l.status,
    })),
  };
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireAuth();
    if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) {
      return NextResponse.json(
        { success: false, error: { message: "FORBIDDEN" } },
        { status: 403 },
      );
    }

    // Anything unrecognised falls back to the queue rather than 400ing. This is
    // a read on a dashboard panel; a typo in a query string should not blank the
    // CEO's screen.
    const approved = req.nextUrl.searchParams.get("status") === "approved";

    const where = approved
      ? and(
          eq(dealerLeadCommercials.approval_status, "approved"),
          // WITHOUT THIS the tab is not "approved quotes" but "every commercials
          // row ever written": the column DEFAULTS to 'approved', so every
          // brochure share, terms update and pre-E-221 row carries it. Only the
          // two gated events were ever a quote somebody could have refused.
          inArray(dealerLeadCommercials.event_type, [...GATED_QUOTE_EVENTS]),
        )
      : eq(dealerLeadCommercials.approval_status, "pending");

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
        oem_evaluation: dealerLeadCommercials.oem_evaluation,
        created_at: dealerLeadCommercials.created_at,
        approval_mode: dealerLeadCommercials.approval_mode,
        approved_at: dealerLeadCommercials.approved_at,
        approved_by: dealerLeadCommercials.approved_by,
        approved_by_name: approver.name,
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
      // Same cast, same reason. Left join because an auto-approved row has no
      // approver at all — approved_by is deliberately NULL there.
      .leftJoin(approver, sql`${approver.id}::text = ${dealerLeadCommercials.approved_by}`)
      .where(where)
      // Pending is oldest first: the queue is worked front to back, and the
      // thing that has waited longest is the thing blocking a rep. Released is
      // newest first — it is a record, not a queue, and the question it answers
      // is "what just went out".
      .orderBy(approved ? desc(decidedAt) : asc(dealerLeadCommercials.created_at))
      .limit(CAP);

    // One aggregate over the whole set, not over the capped page. The released
    // tab's headline is a total, and a total that silently covered only the
    // newest 100 would understate what went out.
    const [totals] = await db
      .select({
        n: sql<number>`COUNT(*)`,
        auto: sql<number>`COUNT(*) FILTER (WHERE ${dealerLeadCommercials.approval_mode} = 'auto')`,
        value: sql<number>`COALESCE(SUM(${quoteValue}), 0)`,
      })
      .from(dealerLeadCommercials)
      .where(where);

    const total = Number(totals?.n || 0);

    return NextResponse.json({
      success: true,
      data: {
        status: approved ? "approved" : "pending",
        // The true count, which can exceed the rows returned — the panel must
        // not imply the list is shorter than it is.
        total,
        capped: total > CAP,
        // Only meaningful on the released tab, where the split between "the
        // rule released this" and "I released this" is the whole point.
        auto_count: approved ? Number(totals?.auto || 0) : 0,
        value_total: approved ? Number(totals?.value || 0) : 0,
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
          oem: summariseEvaluation(r.oem_evaluation),
          raised_by: r.raised_by ?? "(unknown)",
          dealer_name: r.dealer_name ?? "(unnamed lead)",
          city: r.city,
          created_at: r.created_at,
          approval_route: approvalRoute(r.approval_mode, r.approved_by),
          approved_by_name: r.approved_by_name ?? null,
          approved_at: r.approved_at,
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
