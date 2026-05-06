import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, loanSanctions } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";

// BRD V2 §4.0 — access gate for Step 5 (Loan Review + OTP + Dispatch).
//   loan_sanctioned → scenario A (OTP + dispatch)
//   loan_rejected   → scenario B (rejection banner + follow-up actions)
//   dispatched      → scenario C (post-OTP success, awaiting delivery)
//   sold (cash)     → not applicable, redirect home
//   sold (finance)  → terminal — read-only access still permitted
//   any other       → blocked with redirectTo

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId } = await params;

    const [lead] = await db
      .select({
        id: leads.id,
        dealer_id: leads.dealer_id,
        kyc_status: leads.kyc_status,
        payment_method: leads.payment_method,
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
    if (lead.dealer_id !== user.dealer_id) {
      return NextResponse.json(
        { success: false, error: { message: "Access denied" } },
        { status: 403 },
      );
    }

    const kycStatus = String(lead.kyc_status || "");

    // Cash sales complete at Step 4 — no Step 5.
    if (kycStatus === "sold" && String(lead.payment_method || "").toLowerCase() === "cash") {
      return NextResponse.json({
        success: true,
        data: {
          allowed: false,
          redirectTo: `/dealer-portal/leads/${leadId}`,
          reason: "Cash leads complete at Step 4. Step 5 is not applicable.",
        },
      });
    }

    if (kycStatus === "loan_sanctioned") {
      const [loan] = await db
        .select({
          id: loanSanctions.id,
          status: loanSanctions.status,
          sanctioned_at: loanSanctions.sanctioned_at,
          loan_approved_by: loanSanctions.loan_approved_by,
        })
        .from(loanSanctions)
        .where(eq(loanSanctions.lead_id, leadId))
        .orderBy(desc(loanSanctions.created_at))
        .limit(1);

      return NextResponse.json({
        success: true,
        data: {
          allowed: true,
          scenario: "loan_sanctioned",
          loanSanctionId: loan?.id ?? null,
          sanctionedAt: loan?.sanctioned_at ?? null,
          sanctionedBy: loan?.loan_approved_by ?? null,
        },
      });
    }

    if (kycStatus === "dispatched") {
      // Post-OTP intermediate state. Show the dispatch confirmation panel
      // with the Mark Delivered button + auto-finalize countdown.
      return NextResponse.json({
        success: true,
        data: {
          allowed: true,
          scenario: "dispatched",
        },
      });
    }

    if (kycStatus === "loan_rejected") {
      const [loan] = await db
        .select({
          id: loanSanctions.id,
          rejection_reason: loanSanctions.rejection_reason,
          loan_approved_by: loanSanctions.loan_approved_by,
          updated_at: loanSanctions.updated_at,
        })
        .from(loanSanctions)
        .where(eq(loanSanctions.lead_id, leadId))
        .orderBy(desc(loanSanctions.created_at))
        .limit(1);

      return NextResponse.json({
        success: true,
        data: {
          allowed: true,
          scenario: "loan_rejected",
          loanSanctionId: loan?.id ?? null,
          rejectionReason: loan?.rejection_reason ?? null,
          rejectedBy: loan?.loan_approved_by ?? null,
          rejectedAt: loan?.updated_at ?? null,
        },
      });
    }

    // Closed/cancelled leads — read-only redirect home.
    if (kycStatus === "closed_loan_rejected") {
      return NextResponse.json({
        success: true,
        data: {
          allowed: false,
          redirectTo: "/dealer-portal/leads",
          reason: "Lead is closed.",
        },
      });
    }

    // Blocked — redirect to last meaningful step.
    let redirectTo = `/dealer-portal/leads/${leadId}`;
    if (kycStatus === "pending_final_approval") {
      redirectTo = `/dealer-portal/leads/${leadId}/product-selection`;
    } else if (
      kycStatus === "step_3_cleared" ||
      kycStatus === "kyc_approved" ||
      kycStatus === "product_selection_in_progress"
    ) {
      redirectTo = `/dealer-portal/leads/${leadId}/product-selection`;
    }

    return NextResponse.json({
      success: true,
      data: {
        allowed: false,
        redirectTo,
        kycStatus,
        reason: `Step 5 is not available for kyc_status=${kycStatus}.`,
      },
    });
  } catch (error) {
    console.error("[Step 5 Access] Error:", error);
    const message = error instanceof Error ? error.message : "Access check failed";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
