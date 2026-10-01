/**
 * GET /api/partner/quotations?status=pending|approved|rejected|all
 *
 * The partner login's own PI (quotation) list — every quote_issue /
 * quote_revision THIS user raised, with where it stands: waiting on the CEO,
 * released (auto or by the CEO, with the proforma PDF), or refused (with the
 * reason). Nothing else in the app lists a creator's own quotes: the CEO queue
 * (`/api/dashboard/ceo/quotations`) is scoped by approval_status only, and its
 * `mine` filter narrows on the DECIDER, not the raiser.
 *
 * Deliberately its own route rather than a mode on the CEO one. That route is
 * queue-shaped — a cap, totals, the OEM per-line verdict the CEO decides on —
 * and none of that is the partner's question, which is "what did I raise and
 * did it go out". Sharing GATED_QUOTE_EVENTS is the only coupling that matters:
 * approval_status defaults to 'approved' on every commercials row, so without
 * that filter this would list brochure shares and terms updates as "PIs".
 *
 * admin / ceo are admitted for support ("what is Chirag seeing?"); they see
 * their OWN raised quotes, not everyone's — the scope is always created_by.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { dealerLeadCommercials, dealerLeads, users } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";
import { GATED_QUOTE_EVENTS, QUOTE_APPROVAL_STATUSES } from "@/lib/leads/quoteApproval";
import { LIVE_QUOTE_VERSION } from "@/lib/leads/quoteSendGate";
import { quotePriceChanged, type OemEvaluation } from "@/lib/leads/oemPricing";
import { loadLiveOemPrices } from "@/lib/leads/oemPrices";
import type { CommercialsProductLine } from "@/lib/inside-sales/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const READ_ROLES = ["partner", "admin", "ceo"];

/** Beyond this the list is the wrong tool; the lead page has the full history. */
const CAP = 200;

type StatusFilter = "pending" | "approved" | "rejected" | "all";

function parseStatus(raw: string | null): StatusFilter {
  if (raw && (QUOTE_APPROVAL_STATUSES as readonly string[]).includes(raw)) {
    return raw as StatusFilter;
  }
  return "all";
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireRole(READ_ROLES);
    const status = parseStatus(req.nextUrl.searchParams.get("status"));

    const approver = alias(users, "approver");

    // created_by is text and users.id is uuid — cast the uuid, never the text,
    // so a non-uuid created_by cannot raise invalid_text_representation.
    const mine = sql`${dealerLeadCommercials.created_by} = ${user.id}`;
    const gatedOnly = inArray(dealerLeadCommercials.event_type, [...GATED_QUOTE_EVENTS]);
    const base = and(mine, gatedOnly);
    // ID 78: a quote withdrawn while it waited for the CEO is no longer waiting
    // on anyone — it leaves the pending tab and its count. withdrawn_at is
    // E-314 and not in schema.ts, so it is named raw.
    const notWithdrawn = sql`${dealerLeadCommercials}.withdrawn_at IS NULL`;
    const where =
      status === "all"
        ? base
        : status === "pending"
          ? and(base, eq(dealerLeadCommercials.approval_status, status), notWithdrawn)
          : and(base, eq(dealerLeadCommercials.approval_status, status));

    // Pending is oldest first — it is a queue the CEO works front to back, so
    // the top row is the one that has waited longest. Decided rows are newest
    // first: they are a record, and the question is "what just happened".
    const decidedAt = sql`COALESCE(${dealerLeadCommercials.approved_at}, ${dealerLeadCommercials.created_at})`;

    const rows = await db
      .select({
        commercial_id: dealerLeadCommercials.commercial_id,
        dealer_lead_id: dealerLeadCommercials.dealer_lead_id,
        version_no: dealerLeadCommercials.version_no,
        is_current: dealerLeadCommercials.is_current,
        event_type: dealerLeadCommercials.event_type,
        price_quoted: dealerLeadCommercials.price_quoted,
        final_price: dealerLeadCommercials.final_price,
        quote_number: dealerLeadCommercials.quote_number,
        quote_pdf_url: dealerLeadCommercials.quote_pdf_url,
        quote_pdf_error: dealerLeadCommercials.quote_pdf_error,
        quote_document_url: dealerLeadCommercials.quote_document_url,
        approval_status: dealerLeadCommercials.approval_status,
        approval_mode: dealerLeadCommercials.approval_mode,
        approved_at: dealerLeadCommercials.approved_at,
        approved_by_name: approver.name,
        rejection_reason: dealerLeadCommercials.rejection_reason,
        dealer_decision: dealerLeadCommercials.dealer_decision,
        dealer_decision_at: dealerLeadCommercials.dealer_decision_at,
        // ISO, so the browser's Date can read it ("…+00" from ::text cannot be).
        withdrawn_at: sql<string | null>`to_char(${dealerLeadCommercials}.withdrawn_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
        // ID 60: sendable only while no NEWER approved, not-withdrawn version
        // exists — the same rule as the send gate (quoteSendGate.loadQuote).
        is_latest_quote: sql<boolean>`NOT EXISTS (
          SELECT 1 FROM dealer_lead_commercials q
           WHERE q.dealer_lead_id = ${dealerLeadCommercials.dealer_lead_id}
             AND ${LIVE_QUOTE_VERSION}
             AND q.version_no > ${dealerLeadCommercials.version_no}
        )`,
        product_lines: dealerLeadCommercials.product_lines,
        oem_evaluation: dealerLeadCommercials.oem_evaluation,
        created_at: dealerLeadCommercials.created_at,
        payment_method: dealerLeadCommercials.payment_method,
        credit_terms: dealerLeadCommercials.credit_terms,
        delivery_terms: dealerLeadCommercials.delivery_terms,
        warranty_terms: dealerLeadCommercials.warranty_terms,
        deal_notes: dealerLeadCommercials.deal_notes,
        dealer_name: dealerLeads.dealer_name,
        shop_name: dealerLeads.shop_name,
        dealer_phone: dealerLeads.phone,
        city: dealerLeads.city,
        state: dealerLeads.state,
        lead_status: dealerLeads.lead_status,
      })
      .from(dealerLeadCommercials)
      .leftJoin(dealerLeads, eq(dealerLeads.id, dealerLeadCommercials.dealer_lead_id))
      // Left join: an auto-approved row has no approver — approved_by is NULL.
      .leftJoin(approver, sql`${approver.id}::text = ${dealerLeadCommercials.approved_by}`)
      .where(where)
      .orderBy(
        status === "pending"
          ? asc(dealerLeadCommercials.created_at)
          : desc(decidedAt),
      )
      .limit(CAP);

    const countRows = await db
      .select({
        approval_status: dealerLeadCommercials.approval_status,
        n: sql<number>`count(*)::int`,
      })
      .from(dealerLeadCommercials)
      .where(
        and(
          base,
          sql`(${dealerLeadCommercials.approval_status} <> 'pending' OR ${notWithdrawn})`,
        ),
      )
      .groupBy(dealerLeadCommercials.approval_status);

    const counts = { pending: 0, approved: 0, rejected: 0 };
    for (const c of countRows) {
      const k = (c.approval_status ?? "approved") as keyof typeof counts;
      if (k in counts) counts[k] += Number(c.n ?? 0);
    }

    // ID 78: flag an OPEN quote — released, unanswered, not withdrawn — whose
    // product reference price changed since it was issued. Same rule as the
    // lead detail and the CEO panel; a lookup failure leaves the flags off.
    const priceChanged = new Set<string>();
    try {
      const openRows = rows.filter(
        (r) => r.approval_status === "approved" && !r.dealer_decision && !r.withdrawn_at,
      );
      const lines = openRows.flatMap((r) =>
        Array.isArray(r.product_lines) ? (r.product_lines as CommercialsProductLine[]) : [],
      );
      if (lines.length > 0) {
        const live = await loadLiveOemPrices(lines);
        for (const r of openRows) {
          if (quotePriceChanged((r.oem_evaluation as OemEvaluation | null) ?? null, live)) {
            priceChanged.add(r.commercial_id);
          }
        }
      }
    } catch (e) {
      console.warn("[partner/quotations] price-changed flag skipped:", errorMessage(e));
    }

    const quotations = rows.map((r) => ({
      commercial_id: r.commercial_id,
      dealer_lead_id: r.dealer_lead_id,
      version_no: r.version_no,
      is_current: Boolean(r.is_current),
      event_type: r.event_type,
      value: Number(r.final_price ?? r.price_quoted ?? 0),
      quote_number: r.quote_number,
      quote_pdf_url: r.quote_pdf_url,
      quote_pdf_error: r.quote_pdf_error,
      quote_document_url: r.quote_document_url,
      approval_status: (r.approval_status ?? "approved") as "pending" | "approved" | "rejected",
      approval_mode: r.approval_mode,
      approved_at: r.approved_at,
      approved_by_name: r.approved_by_name,
      rejection_reason: r.rejection_reason,
      dealer_decision: r.dealer_decision,
      dealer_decision_at: r.dealer_decision_at,
      withdrawn_at: r.withdrawn_at ?? null,
      is_latest_quote: Boolean(r.is_latest_quote),
      price_changed_since_issue: priceChanged.has(r.commercial_id),
      created_at: r.created_at,
      dealer_name: r.dealer_name,
      shop_name: r.shop_name,
      dealer_phone: r.dealer_phone,
      city: r.city,
      state: r.state,
      lead_status: r.lead_status,
      terms: {
        payment_method: r.payment_method,
        credit_terms: r.credit_terms,
        delivery_terms: r.delivery_terms,
        warranty_terms: r.warranty_terms,
        deal_notes: r.deal_notes,
      },
    }));

    return NextResponse.json({
      success: true,
      data: { status, counts, quotations, capped: rows.length === CAP },
    });
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    const message = errorMessage(error);
    const status =
      message === "FORBIDDEN" || /forbidden/i.test(message)
        ? 403
        : /unauthori[sz]ed|not authenticated/i.test(message)
          ? 401
          : 500;
    console.error("[partner/quotations] GET failed:", error);
    return NextResponse.json({ success: false, error: { message } }, { status });
  }
}
