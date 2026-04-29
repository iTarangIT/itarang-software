export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  dealerAgreementEvents,
  dealerAgreementSigners,
  dealerOnboardingApplications,
} from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { canReInitiateAgreement } from "@/lib/agreement/status";
import { fetchDigioAndSyncSigners } from "@/lib/agreement/sync-signers";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";

type Context = {
  params: Promise<{ dealerId: string }>;
};

export async function GET(_req: NextRequest, context: Context) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;
  try {
    const { dealerId } = await context.params;

    const applicationRows = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, dealerId))
      .limit(1);

    const application = applicationRows[0];

    if (!application) {
      return NextResponse.json(
        { success: false, message: "Application not found" },
        { status: 404 }
      );
    }

    let signerRows = await db
      .select()
      .from(dealerAgreementSigners)
      .where(eq(dealerAgreementSigners.application_id, application.id));

    // Auto-sync from Digio if we detect stale state — agreement is completed (or initiated
    // at all) but any signer is still stuck at 'sent'. This catches the case where the
    // agreement was signed but no manual refresh was ever triggered to sync per-signer rows.
    const hasStaleSigner = signerRows.some((s) => {
      const status = String(s.signer_status || "").toLowerCase();
      return status === "sent" || status === "pending";
    });
    if (application.provider_document_id && signerRows.length > 0 && hasStaleSigner) {
      try {
        const parsed = await fetchDigioAndSyncSigners({
          application_id: application.id,
          providerDocumentId: application.provider_document_id,
          requestId: application.request_id,
        });
        if (parsed) {
          // Re-read signer rows after sync so the response reflects fresh data.
          signerRows = await db
            .select()
            .from(dealerAgreementSigners)
            .where(eq(dealerAgreementSigners.application_id, application.id));
        }
      } catch (syncErr) {
        console.warn("[AGREEMENT TRACKING] auto-sync failed (non-blocking):", syncErr);
      }
    }

    const signerOrder = [
      "dealer",
      "financier",
      "itarang_signatory_1",
      "itarang_signatory_2",
    ];

    const signers = [...signerRows]
      .sort((a, b) => {
        const aIndex = signerOrder.indexOf(a.signer_role || "");
        const bIndex = signerOrder.indexOf(b.signer_role || "");
        return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
      })
      .map((signer) => ({
        id: signer.id,
        signerRole: signer.signer_role || "unknown",
        signerName: signer.signer_name || "Not available",
        signerEmail: signer.signer_email || null,
        signerMobile: signer.signer_mobile || null,
        signingMethod: signer.signing_method || null,
        signerStatus: signer.signer_status || "pending",
        signedAt: signer.signed_at || null,
        providerSigningUrl: signer.provider_signing_url || null,
      }));

    const eventRows = await db
      .select()
      .from(dealerAgreementEvents)
      .where(eq(dealerAgreementEvents.application_id, application.id))
      .orderBy(desc(dealerAgreementEvents.created_at));

    const timeline = eventRows.map((event) => ({
      id: event.id,
      eventType: event.event_type || "event",
      signerRole: event.signer_role || null,
      eventStatus: event.event_status || null,
      createdAt: event.created_at || null,
    }));

    return NextResponse.json({
      success: true,
      data: {
        applicationId: application.id,
        agreementId: application.provider_document_id || null,
        requestId: application.request_id || null,
        agreementStatus: application.agreement_status || "not_generated",
        reviewStatus: application.review_status || null,
        signedAgreementUrl: application.signed_agreement_url || null,
        auditTrailUrl: application.audit_trail_url || null,
        completionStatus: application.completion_status || null,
        stampStatus: application.stamp_status || null,
        failureReason: application.agreement_failure_reason || null,
        lastActionTimestamp: application.last_action_timestamp || null,
        canReInitiate: canReInitiateAgreement(application.agreement_status),
        signers,
        timeline,
      },
    });
  } catch (error: any) {
    console.error("AGREEMENT TRACKING GET ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Failed to fetch agreement tracking",
      },
      { status: 500 }
    );
  }
}