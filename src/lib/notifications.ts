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
}) {
  if (params.decision === "approved") {
    await notifyDealerForLead({
      leadId: params.leadId,
      type: "kyc_approved_final",
      title: "KYC Approved",
      message: "KYC verification has been approved. The lead is now verified and ready to proceed.",
      data: { decision: params.decision, admin_notes: params.notes },
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
