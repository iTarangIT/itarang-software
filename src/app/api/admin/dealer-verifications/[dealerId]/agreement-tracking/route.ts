export const runtime = "nodejs";

import { NextRequest, NextResponse, after } from "next/server";
import { db } from "@/lib/db";
import {
  dealerAgreementEvents,
  dealerAgreementSigners,
  dealerOnboardingApplications,
} from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { canReInitiateAgreement } from "@/lib/agreement/status";
import { refreshDealerAgreementFromDigio } from "@/lib/agreement/refresh-dealer-agreement";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";

type Context = {
  params: Promise<{ dealerId: string }>;
};

// Nothing left to sync for these — polling the tracking endpoint must not keep
// hitting Digio once the agreement has settled (or was never initiated).
const TERMINAL_AGREEMENT_STATUSES = new Set(["completed", "failed", "expired", "not_generated"]);

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

    const signerRows = await db
      .select()
      .from(dealerAgreementSigners)
      .where(eq(dealerAgreementSigners.application_id, application.id));

    // Self-heal stale state — agreement initiated but not yet terminal (a signer
    // still 'sent'/'pending', or every signer signed but agreement_status hasn't
    // caught up). Run the FULL refresh (same as the "Refresh Status" button:
    // signer sync + agreement_status + signed PDF / audit-trail caching) so the
    // review page reaches "completed" on its own — the client polls this
    // endpoint while the agreement is in flight and picks the result up on its
    // next tick. The Digio status call is SLOW (intermittent 500s + retries),
    // so it runs in the BACKGROUND via after() instead of blocking this
    // response — otherwise the whole review page hangs on it. The lib throttles
    // overlapping auto-runs per application.
    const hasStaleSigner = signerRows.some((s) => {
      const status = String(s.signer_status || "").toLowerCase();
      return status === "sent" || status === "pending";
    });
    const agreementStatus = String(application.agreement_status || "").toLowerCase();
    const isNonTerminal = !TERMINAL_AGREEMENT_STATUSES.has(agreementStatus);
    const needsSync =
      !!application.provider_document_id &&
      application.agreement_mode !== "manual" &&
      (hasStaleSigner || isNonTerminal);
    if (needsSync) {
      after(async () => {
        try {
          const result = await refreshDealerAgreementFromDigio(application, { source: "auto" });
          if (!result.ok && result.status !== 429) {
            console.warn("[AGREEMENT TRACKING] background auto-refresh failed:", result.status, result.message);
          }
        } catch (syncErr) {
          console.warn("[AGREEMENT TRACKING] background auto-refresh threw:", syncErr);
        }
      });
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