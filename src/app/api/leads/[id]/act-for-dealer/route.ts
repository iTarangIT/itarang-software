// ID 183 — GET /api/leads/[id]/act-for-dealer
//
// What the CRM "Act for dealer" panel (admin/kyc-review/[leadId]) shows to
// Admin / Sales Head: may they act now and why not, who is working the file
// ("being worked by <name>" for 30 minutes), the dealer's last action (sent
// back on every step as the x-seen-dealer-action-at header — dealer wins),
// the documents with who uploaded each, who sent / entered each consent code,
// the coupon, the stage, and every "Done by <name> for <dealer>" line.
//
// The steps themselves are the ordinary routes (kyc/[leadId]/upload-document,
// send-consent, verify-consent-otp, validate-coupon, submit-verification and,
// Phase 2, the lead/[id]/* lender-journey routes); each runs the same gate
// (lib/leads/actForDealerGuard gateLeadActor) and runs as the FILE's dealer.

import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { consentOtpVerifications, consentRecords, kycDocuments, leads, users } from "@/lib/db/schema";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";
import { isActForDealerRole, SEEN_DEALER_ACTION_HEADER, WORK_LOCK_MINUTES } from "@/lib/leads/actForDealer";
import { actHistory, fileDealerNames, readActState } from "@/lib/leads/actForDealerGuard";
import { pushedFileStage } from "@/lib/leads/pushedFiles";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireAuth();
  if (!isActForDealerRole(user.role)) return errorResponse("Only Admin or Sales Head can act for the dealer.", 403);
  const leadId = (await params).id;

  const [lead] = await db
    .select({
      id: leads.id,
      ref: leads.reference_id,
      name: leads.full_name,
      owner: leads.owner_name,
      dealerId: leads.dealer_id,
      kycStatus: leads.kyc_status,
      workflowStep: leads.workflow_step,
      paymentMethod: leads.payment_method,
      couponCode: leads.coupon_code,
      couponStatus: leads.coupon_status,
      consentStatus: leads.consent_status,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) return errorResponse("Lead not found", 404);

  const [state, names, docs, sessions, consent, history] = await Promise.all([
    readActState(leadId, user),
    fileDealerNames(lead.dealerId),
    db
      .select({
        id: kycDocuments.id,
        docType: kycDocuments.doc_type,
        docFor: kycDocuments.doc_for,
        fileName: kycDocuments.file_name,
        uploadedAt: kycDocuments.uploaded_at,
        updatedAt: kycDocuments.updated_at,
        status: kycDocuments.verification_status,
        uploadedBy: users.name,
      })
      .from(kycDocuments)
      .leftJoin(users, eq(users.id, kycDocuments.uploaded_by))
      .where(eq(kycDocuments.lead_id, leadId))
      .orderBy(desc(kycDocuments.updated_at)),
    db
      .select({
        id: consentOtpVerifications.id,
        consentFor: consentOtpVerifications.consentFor,
        createdAt: consentOtpVerifications.createdAt,
        expiresAt: consentOtpVerifications.expiresAt,
        sendCount: consentOtpVerifications.sendCount,
        verifiedAt: consentOtpVerifications.verifiedAt,
        consumedAt: consentOtpVerifications.consumedAt,
        channel: consentOtpVerifications.deliveryChannel,
        sentBy: users.name,
      })
      .from(consentOtpVerifications)
      .leftJoin(users, eq(users.id, consentOtpVerifications.requestedBy))
      .where(eq(consentOtpVerifications.leadId, leadId))
      .orderBy(desc(consentOtpVerifications.createdAt))
      .limit(10),
    db
      .select({
        id: consentRecords.id,
        consentFor: consentRecords.consent_for,
        status: consentRecords.consent_status,
        otpVerificationId: consentRecords.otp_verification_id,
        verifiedAt: consentRecords.verified_at,
        verifiedBy: consentRecords.verified_by,
      })
      .from(consentRecords)
      .where(and(eq(consentRecords.lead_id, leadId)))
      .orderBy(desc(consentRecords.updated_at)),
    actHistory(leadId),
  ]);

  // Who entered each code: consent_records.verified_by of the record that the
  // session verified.
  const verifierIds = [...new Set(consent.map((c) => c.verifiedBy).filter((x): x is string => !!x))];
  const verifierNames = new Map<string, string>();
  if (verifierIds.length) {
    const vs = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, verifierIds));
    for (const v of vs) verifierNames.set(v.id, v.name);
  }
  const enteredBy = new Map<string, string | null>();
  for (const c of consent) {
    if (c.otpVerificationId) enteredBy.set(c.otpVerificationId, c.verifiedBy ? verifierNames.get(c.verifiedBy) ?? null : null);
  }
  const nowMs = Date.parse(state.now);

  return successResponse({
    lead: {
      id: lead.id,
      referenceId: lead.ref,
      customerName: lead.name || lead.owner || "Customer",
      kycStatus: lead.kycStatus,
      stage: pushedFileStage(lead.kycStatus, lead.workflowStep),
      paymentMethod: lead.paymentMethod,
      couponCode: lead.couponCode,
      couponStatus: lead.couponStatus,
      consentStatus: (consent.find((c) => c.consentFor === "primary")?.status ?? lead.consentStatus) || null,
    },
    dealer: { dealerId: lead.dealerId, name: names.display },
    me: { userId: user.id, name: user.name },
    ...state,
    lockMinutes: WORK_LOCK_MINUTES,
    seenHeader: SEEN_DEALER_ACTION_HEADER,
    documents: docs.map((d) => ({
      id: d.id,
      docType: d.docType,
      docFor: d.docFor,
      fileName: d.fileName,
      status: d.status,
      uploadedAt: (d.updatedAt ?? d.uploadedAt)?.toISOString() ?? null,
      uploadedBy: d.uploadedBy ?? null,
    })),
    consentCodes: sessions.map((s) => ({
      id: s.id,
      consentFor: s.consentFor,
      sentAt: s.createdAt.toISOString(),
      sentBy: s.sentBy ?? null,
      sendCount: s.sendCount,
      channel: s.channel,
      live: !s.verifiedAt && !s.consumedAt && s.expiresAt.getTime() > nowMs,
      expiresAt: s.expiresAt.toISOString(),
      verifiedAt: s.verifiedAt?.toISOString() ?? null,
      enteredBy: enteredBy.get(s.id) ?? null,
    })),
    history,
  });
});
