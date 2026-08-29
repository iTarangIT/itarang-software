/**
 * Dealer-facing notification helpers.
 *
 * These are the oldest notification writers in the codebase and every one of
 * them was invisible. They inserted rows keyed ONLY by `dealer_id`, while the
 * bell (`/api/notifications`) is scoped by `user_id` — so the dealer bell was
 * permanently empty no matter how many rows piled up. The one route that did
 * read `dealer_id` was never wired to any component.
 *
 * The fix is a single change of plumbing, not of behaviour: every helper here
 * now goes through `emit()` (src/lib/notifications/emit.ts), which resolves the
 * dealer to their actual logins and writes one row per person WITH `user_id`
 * set (and `dealer_id` still stamped, so anything else reading it keeps
 * working). The call sites, the copy, the `type` strings and the `data` payloads
 * are unchanged — this file's public API is exactly what it was.
 *
 * Every helper stays best-effort: `emit()` never throws, so a notification can
 * never fail the action that produced it.
 */
import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

import { emit } from "@/lib/notifications/emit";
import { actingParty, dealerParty, type Party } from "@/lib/notifications/provenance";

interface NotifyDealerParams {
  leadId: string;
  type: string;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  /** Where in the journey this happened — rendered on the provenance line. */
  stage?: string | null;
  /** Who raised it. Defaults to the acting session (usually the admin). */
  from?: Party;
}

/**
 * Notify a dealer that admin assigned new inventory to them.
 * Used after a successful bulk-upload or single-item add.
 */
export async function notifyInventoryAssigned(params: {
  dealerId: string;
  assetType: "battery" | "charger" | "paraphernalia";
  count: number;
  reportId?: string | null;
}) {
  await emit({
    type: "inventory_assigned",
    title: "New stock available",
    message: `${params.count} ${params.assetType} item${params.count === 1 ? "" : "s"} assigned to your inventory.`,
    stage: "Inventory",
    from: await actingParty(),
    data: {
      asset_type: params.assetType,
      count: params.count,
      report_id: params.reportId ?? null,
    },
    to: [
      {
        audience: { kind: "dealer", dealerId: params.dealerId },
        as: dealerParty("Dealer"),
        href: "/dealer-portal/inventory",
      },
    ],
  });
}

/**
 * BRD V2 §5.4 — incoming inter-dealer transfer.
 * Tells the target dealer they need to acknowledge receipt.
 */
export async function notifyInventoryTransferIncoming(params: {
  targetDealerId: string;
  transferId: string;
  serialCount: number;
  sourceDealerName?: string | null;
}) {
  await emit({
    type: "inventory_transfer_incoming",
    title: "Incoming inventory transfer",
    message:
      `${params.serialCount} item${params.serialCount === 1 ? "" : "s"} are being transferred to you` +
      (params.sourceDealerName ? ` from ${params.sourceDealerName}` : "") +
      ". Acknowledge receipt when stock arrives.",
    stage: "Inventory",
    from: params.sourceDealerName ? dealerParty(params.sourceDealerName) : await actingParty(),
    data: {
      transfer_id: params.transferId,
      serial_count: params.serialCount,
      source_dealer_name: params.sourceDealerName ?? null,
    },
    to: [
      {
        audience: { kind: "dealer", dealerId: params.targetDealerId },
        as: dealerParty("Dealer"),
        href: "/dealer-portal/inventory",
      },
    ],
  });
}

/**
 * BRD V2 §5.4 — transfer acknowledged by target dealer.
 * Confirms back to source dealer that the transfer cleared.
 */
export async function notifyInventoryTransferAcknowledged(params: {
  sourceDealerId: string;
  transferId: string;
  serialCount: number;
  targetDealerName?: string | null;
}) {
  await emit({
    type: "inventory_transfer_acknowledged",
    title: "Transfer acknowledged",
    message:
      `${params.serialCount} item${params.serialCount === 1 ? "" : "s"} acknowledged` +
      (params.targetDealerName ? ` by ${params.targetDealerName}` : "") +
      ". Stock has left your inventory.",
    stage: "Inventory",
    from: params.targetDealerName ? dealerParty(params.targetDealerName) : await actingParty(),
    data: {
      transfer_id: params.transferId,
      serial_count: params.serialCount,
      target_dealer_name: params.targetDealerName ?? null,
    },
    to: [
      {
        audience: { kind: "dealer", dealerId: params.sourceDealerId },
        as: dealerParty("Dealer"),
        href: "/dealer-portal/inventory",
      },
    ],
  });
}

/**
 * Creates a notification for the dealer who owns the lead.
 *
 * The workhorse behind almost every dealer notification. `emit()` resolves
 * leads.dealer_id → that dealer's logins, so the row lands in a bell rather than
 * in a column nobody reads.
 */
export async function notifyDealerForLead(params: NotifyDealerParams) {
  try {
    const [lead] = await db
      .select({
        dealer_id: leads.dealer_id,
        full_name: leads.full_name,
        owner_name: leads.owner_name,
      })
      .from(leads)
      .where(eq(leads.id, params.leadId))
      .limit(1);

    if (!lead?.dealer_id) return;

    const leadName = lead.full_name || lead.owner_name || "";
    const href =
      (params.data?.href as string | undefined) ?? `/dealer-portal/leads/${params.leadId}`;

    await emit({
      type: params.type,
      title: params.title,
      message: params.message,
      leadId: params.leadId,
      stage: params.stage ?? null,
      from: params.from ?? (await actingParty()),
      data: { ...params.data, lead_name: leadName },
      to: [
        {
          audience: { kind: "dealer", dealerId: lead.dealer_id },
          as: dealerParty("Dealer"),
          href,
        },
      ],
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
  // 'co_borrower' routes the dealer bell to Step 3; anything else → Step 2.
  verificationFor?: string | null;
}) {
  const label = VERIFICATION_LABELS[params.verificationType] || params.verificationType;

  // Deep-link the dealer bell to the exact page + point (the bell prioritises
  // data.href). Requested/rejected docs surface in the Additional Documents
  // section, so anchor there.
  const isCoBorrower = (params.verificationFor ?? "").toLowerCase() === "co_borrower";
  const basePage = isCoBorrower
    ? `/dealer-portal/leads/${params.leadId}/borrower-consent`
    : `/dealer-portal/leads/${params.leadId}/kyc`;
  const docsHref = `${basePage}#other-documentation`;
  const stage = isCoBorrower ? "Step 3 · Co-borrower KYC" : "Step 2 · KYC";

  if (params.action === "request_more_docs") {
    await notifyDealerForLead({
      leadId: params.leadId,
      type: "kyc_docs_requested",
      title: `${label} — more documents needed`,
      stage,
      message: params.notes
        ? `iTarang admin requested additional documents for ${label} verification. Reason: ${params.notes}`
        : `iTarang admin requested additional documents for ${label} verification. Please upload the required documents.`,
      data: {
        verification_type: params.verificationType,
        action: params.action,
        admin_notes: params.notes,
        href: docsHref,
      },
    });
  } else if (params.action === "rejected") {
    await notifyDealerForLead({
      leadId: params.leadId,
      type: "kyc_rejected",
      title: `${label} verification rejected`,
      stage,
      message: params.notes
        ? `iTarang admin rejected the ${label} verification. Reason: ${params.notes}`
        : `iTarang admin rejected the ${label} verification. Please review and re-submit.`,
      data: {
        verification_type: params.verificationType,
        action: params.action,
        admin_notes: params.notes,
        href: basePage,
      },
    });
  } else if (params.action === "accepted") {
    await notifyDealerForLead({
      leadId: params.leadId,
      type: "kyc_accepted",
      title: `${label} Verification Accepted`,
      stage,
      message: `${label} verification has been accepted successfully.`,
      data: {
        verification_type: params.verificationType,
        action: params.action,
        href: basePage,
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
  // Nullable since E-246: the SLA sweep makes this decision with no human
  // actor. Not read in the body — the dealer-facing copy never names the admin.
  adminId: string | null;
  leadStatus?: string | null; // step_3_cleared, kyc_approved, kyc_rejected
}) {
  if (params.decision === "approved") {
    const isStep3 = params.leadStatus === "step_3_cleared";
    await notifyDealerForLead({
      leadId: params.leadId,
      type: isStep3 ? "step_3_cleared" : "kyc_approved_final",
      title: isStep3 ? "Step 3 Cleared — Product Selection Unlocked" : "KYC Approved",
      stage: isStep3 ? "Step 3" : "Step 2 · KYC",
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
      stage: "Step 2 · KYC",
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
    stage: "Step 3",
    message: params.rejectionReason || params.notes || "Admin has returned this lead with outstanding items. Please review and re-submit.",
    data: {
      lead_status: params.leadStatus,
      admin_notes: params.notes,
      rejection_reason: params.rejectionReason,
      href: `/dealer-portal/leads/${params.leadId}/borrower-consent`,
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
    stage: "Step 4 · Sanction",
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
    stage: "Step 4 · Sanction",
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
  /** Null on finance — the price is settled on Step 5, after the lender quotes. */
  finalPrice: number | string | null;
}) {
  const at = params.finalPrice != null ? ` (₹${params.finalPrice})` : "";
  await notifyDealerForLead({
    leadId: params.leadId,
    type: params.paymentMode === "cash" ? "cash_sale_confirmed" : "product_selection_submitted",
    title: params.paymentMode === "cash" ? "Sale Confirmed" : "Sent to NBFC",
    stage: "Step 4 · Product Selection",
    message:
      params.paymentMode === "cash"
        ? `Sale confirmed for ₹${params.finalPrice}. Warranty activated.`
        : `Application sent to the selected lender(s)${at}. Awaiting their offer.`,
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
    stage: "Step 5 · Dispatch",
    message: `Battery ${params.batterySerial} dispatched. Warranty ${params.warrantyId} activated. Awaiting delivery confirmation.`,
    data: {
      warranty_id: params.warrantyId,
      battery_serial: params.batterySerial,
    },
  });
}

/**
 * Notify dealer when a previously-dispatched lead has been marked delivered
 * (either by the dealer's manual click or the daily cron).
 */
export async function notifyDelivered(params: {
  leadId: string;
  warrantyId: string;
  batterySerial: string;
  source: "manual" | "cron";
}) {
  await notifyDealerForLead({
    leadId: params.leadId,
    type: "delivery_confirmed",
    title: "Delivery Confirmed",
    stage: "Step 5 · Delivery",
    message:
      params.source === "manual"
        ? `Battery ${params.batterySerial} marked delivered. Sale finalized.`
        : `Battery ${params.batterySerial} auto-finalized after dispatch window. Sale closed.`,
    data: {
      warranty_id: params.warrantyId,
      battery_serial: params.batterySerial,
      source: params.source,
    },
  });
}
