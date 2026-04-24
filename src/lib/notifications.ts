import { db } from "@/lib/db";
import { notifications, leads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

function genId(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `NOTIF-${ts}-${rand}`;
}

interface NotifyDealerParams {
  leadId: string;
  type: string;
  title: string;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Creates a notification for the dealer who owns the lead.
 * Looks up dealer_id from the lead record.
 */
export async function notifyDealerForLead(params: NotifyDealerParams) {
  try {
    const leadRows = await db
      .select({
        dealer_id: leads.dealer_id,
        full_name: leads.full_name,
        owner_name: leads.owner_name,
      })
      .from(leads)
      .where(eq(leads.id, params.leadId))
      .limit(1);

    const lead = leadRows[0];
    if (!lead?.dealer_id) return;

    await db.insert(notifications).values({
      id: genId(),
      dealer_id: lead.dealer_id,
      lead_id: params.leadId,
      type: params.type,
      title: params.title,
      message: params.message,
      data: {
        ...params.data,
        lead_name: lead.full_name || lead.owner_name || "",
      },
    });
  } catch (error) {
    console.error("[Notification] Failed to create:", error);
  }
}

const VERIFICATION_LABELS: Record<string, string> = {
  aadhaar: "Aadhaar",
  pan: "PAN",
  bank: "Bank Account",
  cibil: "CIBIL Credit",
  rc: "RC (Vehicle)",
};

/**
 * Notify dealer when admin takes action on a verification card.
 */
export async function notifyKycCardAction(params: {
  leadId: string;
  verificationType: string;
  action: string; // accepted, rejected, request_more_docs
  notes?: string | null;
  adminId: string;
}) {
  const label = VERIFICATION_LABELS[params.verificationType] || params.verificationType;

  if (params.action === "request_more_docs") {
    await notifyDealerForLead({
      leadId: params.leadId,
      type: "kyc_docs_requested",
      title: `${label} Verification - More Documents Needed`,
      message: params.notes
        ? `Admin has requested additional documents for ${label} verification. Reason: ${params.notes}`
        : `Admin has requested additional documents for ${label} verification. Please upload the required documents.`,
      data: {
        verification_type: params.verificationType,
        action: params.action,
        admin_notes: params.notes,
      },
    });
  } else if (params.action === "rejected") {
    await notifyDealerForLead({
      leadId: params.leadId,
      type: "kyc_rejected",
      title: `${label} Verification Rejected`,
      message: params.notes
        ? `${label} verification was rejected. Reason: ${params.notes}`
        : `${label} verification was rejected. Please review and re-submit.`,
      data: {
        verification_type: params.verificationType,
        action: params.action,
        admin_notes: params.notes,
      },
    });
  } else if (params.action === "accepted") {
    await notifyDealerForLead({
      leadId: params.leadId,
      type: "kyc_accepted",
      title: `${label} Verification Accepted`,
      message: `${label} verification has been accepted successfully.`,
      data: {
        verification_type: params.verificationType,
        action: params.action,
      },
    });
  }
}

/**
 * Notify dealer when final KYC decision is made.
 */
export async function notifyKycFinalDecision(params: {
  leadId: string;
  decision: string; // approved, rejected
  notes?: string | null;
  rejectionReason?: string | null;
  adminId: string;
  leadStatus?: string | null; // step_3_cleared, kyc_approved, kyc_rejected
}) {
  if (params.decision === "approved") {
    const isStep3 = params.leadStatus === "step_3_cleared";
    await notifyDealerForLead({
      leadId: params.leadId,
      type: isStep3 ? "step_3_cleared" : "kyc_approved_final",
      title: isStep3 ? "Step 3 Cleared — Product Selection Unlocked" : "KYC Approved",
      message: isStep3
        ? "Re-verification approved. You can now proceed to product selection."
        : "KYC verification has been approved. The lead is now verified and ready to proceed.",
      data: { decision: params.decision, admin_notes: params.notes, lead_status: params.leadStatus },
    });
  } else {
    await notifyDealerForLead({
      leadId: params.leadId,
      type: "kyc_rejected_final",
      title: "KYC Rejected",
      message: params.rejectionReason
        ? `KYC verification has been rejected. Reason: ${params.rejectionReason}`
        : "KYC verification has been rejected. Please contact admin for details.",
      data: {
        decision: params.decision,
        rejection_reason: params.rejectionReason,
        admin_notes: params.notes,
      },
    });
  }
}

/**
 * Notify dealer when admin uses Step 3 "Dealer Action Required" to push the
 * case back with outstanding items (rejected supporting docs, co-borrower
 * replacement required, etc.).
 */
export async function notifyStep3DealerActionRequired(params: {
  leadId: string;
  leadStatus: string; // awaiting_additional_docs | awaiting_co_borrower_kyc | awaiting_co_borrower_replacement | awaiting_doc_reupload | awaiting_both
  notes?: string | null;
  rejectionReason?: string | null;
}) {
  const reasonLabels: Record<string, string> = {
    awaiting_additional_docs: "Additional documents required",
    awaiting_doc_reupload: "Re-upload required for one or more documents",
    awaiting_co_borrower_kyc: "Co-borrower KYC requires attention",
    awaiting_co_borrower_replacement: "A new co-borrower is required",
    awaiting_both: "Both supporting documents and co-borrower require attention",
  };
  const label = reasonLabels[params.leadStatus] || "Action required";

  await notifyDealerForLead({
    leadId: params.leadId,
    type: "step_3_dealer_action_required",
    title: `Action Required — ${label}`,
    message: params.rejectionReason || params.notes || "Admin has returned this lead with outstanding items. Please review and re-submit.",
    data: {
      lead_status: params.leadStatus,
      admin_notes: params.notes,
      rejection_reason: params.rejectionReason,
    },
  });
}

/**
 * Notify dealer when admin sanctions the loan in Step 4 (finance path).
 */
export async function notifyLoanSanctioned(params: {
  leadId: string;
  loanSanctionId: string;
  lenderName: string;
  loanAmount: number | string;
  emi: number | string;
  tenureMonths: number;
}) {
  await notifyDealerForLead({
    leadId: params.leadId,
    type: "loan_sanctioned",
    title: "Loan Sanctioned — Customer Approval Needed",
    message: `Loan of ₹${params.loanAmount} sanctioned by ${params.lenderName}. Proceed to Step 5 for customer OTP confirmation.`,
    data: {
      loan_sanction_id: params.loanSanctionId,
      lender_name: params.lenderName,
      loan_amount: params.loanAmount,
      emi: params.emi,
      tenure_months: params.tenureMonths,
    },
  });
}

/**
 * Notify dealer when admin rejects the loan.
 */
export async function notifyLoanRejected(params: {
  leadId: string;
  rejectionReason: string;
  lenderName?: string | null;
}) {
  await notifyDealerForLead({
    leadId: params.leadId,
    type: "loan_rejected",
    title: "Loan Rejected",
    message: `Loan application was not approved${params.lenderName ? ` by ${params.lenderName}` : ""}. Reason: ${params.rejectionReason}`,
    data: {
      rejection_reason: params.rejectionReason,
      lender_name: params.lenderName,
    },
  });
}

/**
 * Notify dealer when a finance product selection is submitted for admin
 * final approval (queue entry notification to admins could go elsewhere).
 */
export async function notifyProductSelectionSubmitted(params: {
  leadId: string;
  productSelectionId: string;
  paymentMode: "cash" | "finance";
  finalPrice: number | string;
}) {
  await notifyDealerForLead({
    leadId: params.leadId,
    type: params.paymentMode === "cash" ? "cash_sale_confirmed" : "product_selection_submitted",
    title: params.paymentMode === "cash" ? "Sale Confirmed" : "Submitted for Final Approval",
    message:
      params.paymentMode === "cash"
        ? `Sale confirmed for ₹${params.finalPrice}. Warranty activated.`
        : `Product selection submitted for final approval (₹${params.finalPrice}). Awaiting admin decision.`,
    data: {
      product_selection_id: params.productSelectionId,
      payment_mode: params.paymentMode,
      final_price: params.finalPrice,
    },
  });
}

/**
 * Notify dealer on successful Step 5 dispatch confirmation (finance path).
 */
export async function notifyDispatchConfirmed(params: {
  leadId: string;
  warrantyId: string;
  batterySerial: string;
}) {
  await notifyDealerForLead({
    leadId: params.leadId,
    type: "dispatch_confirmed",
    title: "Dispatch Confirmed",
    message: `Battery ${params.batterySerial} dispatched. Warranty ${params.warrantyId} activated.`,
    data: {
      warranty_id: params.warrantyId,
      battery_serial: params.batterySerial,
    },
  });
}
