import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  coBorrowerRequests,
  leads,
  otherDocumentRequests,
} from "@/lib/db/schema";

// BRD §2.9.3 — single endpoint that powers the dealer Step 3 page header,
// banner, and section gating. Returns:
//   - lead_kyc_status                    : raw status from leads.kyc_status
//   - requires_supporting_docs           : true if Section A should render
//   - requires_co_borrower               : true if Section B should render
//   - is_replacement                     : true if this is a co-borrower replacement
//   - latest_co_borrower_request         : the most recent co_borrower_requests row
//   - supporting_docs_summary            : counts of other_document_requests for this lead
//
// Read-only. No writes.

const SUPPORTING_DOC_STATUSES = new Set([
  "awaiting_additional_docs",
  "awaiting_both",
  "awaiting_doc_reupload",
  "pending_itarang_reverification",
]);

const CO_BORROWER_STATUSES = new Set([
  "awaiting_co_borrower_kyc",
  "awaiting_both",
  "awaiting_co_borrower_replacement",
  "pending_itarang_reverification",
]);

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const { leadId } = await params;

    const leadRow = await db
      .select({
        id: leads.id,
        kyc_status: leads.kyc_status,
        has_co_borrower: leads.has_co_borrower,
        has_additional_docs_required: leads.has_additional_docs_required,
      })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);

    if (!leadRow.length) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }

    const lead = leadRow[0];
    const status = lead.kyc_status ?? "";

    // Latest open co-borrower request, if any (used for banner + replacement flag)
    const latestCbRequest = await db
      .select({
        id: coBorrowerRequests.id,
        attempt_number: coBorrowerRequests.attempt_number,
        reason: coBorrowerRequests.reason,
        status: coBorrowerRequests.status,
        created_at: coBorrowerRequests.created_at,
      })
      .from(coBorrowerRequests)
      .where(eq(coBorrowerRequests.lead_id, leadId))
      .orderBy(desc(coBorrowerRequests.created_at))
      .limit(1);

    const latestCb = latestCbRequest[0] ?? null;

    // Supporting docs summary for the standard request banner
    const otherDocs = await db
      .select({
        is_required: otherDocumentRequests.is_required,
        upload_status: otherDocumentRequests.upload_status,
      })
      .from(otherDocumentRequests)
      .where(
        and(
          eq(otherDocumentRequests.lead_id, leadId),
          eq(otherDocumentRequests.doc_for, "primary"),
        ),
      );

    const summary = {
      total: otherDocs.length,
      required: otherDocs.filter((d) => d.is_required === true).length,
      uploaded: otherDocs.filter((d) =>
        ["uploaded", "verified"].includes(d.upload_status),
      ).length,
      verified: otherDocs.filter((d) => d.upload_status === "verified").length,
      rejected: otherDocs.filter((d) => d.upload_status === "rejected").length,
    };

    const requires_supporting_docs =
      SUPPORTING_DOC_STATUSES.has(status) && summary.total > 0;

    const requires_co_borrower =
      CO_BORROWER_STATUSES.has(status) || lead.has_co_borrower === true;

    const is_replacement =
      status === "awaiting_co_borrower_replacement" ||
      (latestCb?.attempt_number ?? 0) > 1;

    return NextResponse.json({
      success: true,
      data: {
        lead_kyc_status: status,
        requires_supporting_docs,
        requires_co_borrower,
        is_replacement,
        latest_co_borrower_request: latestCb
          ? {
              id: latestCb.id,
              attempt_number: latestCb.attempt_number,
              reason: latestCb.reason,
              status: latestCb.status,
              created_at: latestCb.created_at,
            }
          : null,
        supporting_docs_summary: summary,
      },
    });
  } catch (error) {
    console.error("[Step3 Context] Error:", error);
    return NextResponse.json(
      { success: false, error: { message: "Server error" } },
      { status: 500 },
    );
  }
}
