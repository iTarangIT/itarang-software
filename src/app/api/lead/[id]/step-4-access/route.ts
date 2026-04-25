import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";

// BRD V2 Part E §2.1 — access gate for Step 4 Product Selection.
//   Finance path: allowed only when kyc_status is step_3_cleared or kyc_approved
//   Cash path:    allowed immediately after Step 1 when payment_method='cash'
//   Otherwise:    blocked, with a redirectTo pointing at the last valid step.

const FINANCE_UNLOCKED = new Set(["step_3_cleared", "kyc_approved"]);
const STEP_3_STATES = new Set([
  "awaiting_additional_docs",
  "awaiting_co_borrower_kyc",
  "awaiting_co_borrower_replacement",
  "awaiting_doc_reupload",
  "awaiting_both",
  "pending_itarang_reverification",
]);

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireRole(["dealer"]);
    const { id: leadId } = await params;

    const [lead] = await db
      .select({
        id: leads.id,
        dealer_id: leads.dealer_id,
        payment_method: leads.payment_method,
        kyc_status: leads.kyc_status,
        product_category_id: leads.product_category_id,
        product_type_id: leads.product_type_id,
      })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);

    if (!lead) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }

    const paymentMode = String(lead.payment_method || "").toLowerCase();
    const kycStatus = String(lead.kyc_status || "");

    // Cash path — unlocked right after Step 1
    if (paymentMode === "cash") {
      return NextResponse.json({
        success: true,
        data: {
          allowed: true,
          paymentMode: "cash",
          dealerId: lead.dealer_id,
          category: lead.product_category_id,
          subCategory: lead.product_type_id,
          kycStatus,
        },
      });
    }

    // Finance path — requires KYC cleared
    if (FINANCE_UNLOCKED.has(kycStatus)) {
      return NextResponse.json({
        success: true,
        data: {
          allowed: true,
          paymentMode: "finance",
          dealerId: lead.dealer_id,
          category: lead.product_category_id,
          subCategory: lead.product_type_id,
          kycStatus,
        },
      });
    }

    // Post-Step-4 states: still consider Step 4 "open" for viewing the
    // submitted product — but read-only. Client decides rendering.
    if (
      kycStatus === "pending_final_approval" ||
      kycStatus === "loan_sanctioned" ||
      kycStatus === "loan_rejected"
    ) {
      return NextResponse.json({
        success: true,
        data: {
          allowed: true,
          paymentMode: "finance",
          dealerId: lead.dealer_id,
          readOnly: true,
          kycStatus,
        },
      });
    }

    // Redirect routing
    let redirectTo = `/dealer-portal/leads/${leadId}`;
    if (STEP_3_STATES.has(kycStatus)) {
      redirectTo = `/dealer-portal/leads/${leadId}/kyc/interim`;
    } else if (kycStatus === "not_started" || kycStatus === "draft" || kycStatus === "in_progress") {
      redirectTo = `/dealer-portal/leads/${leadId}/kyc`;
    } else if (kycStatus === "kyc_rejected" || kycStatus === "sold") {
      redirectTo = `/dealer-portal/leads/${leadId}`;
    }

    return NextResponse.json({
      success: true,
      data: {
        allowed: false,
        redirectTo,
        kycStatus,
        reason: `Lead kyc_status=${kycStatus} does not permit Step 4 entry`,
      },
    });
  } catch (error) {
    console.error("[Step 4 Access] Error:", error);
    const message = error instanceof Error ? error.message : "Access check failed";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
