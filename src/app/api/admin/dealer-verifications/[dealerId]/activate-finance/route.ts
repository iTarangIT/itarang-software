import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { dealerOnboardingApplications, dealers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import { insertAgreementEvent } from "@/lib/agreement/tracking";
import { ensureDealerAuditTrailUrl } from "@/lib/digio/ensure-audit-trail";
import { ensureDealerSignedAgreementUrl } from "@/lib/digio/ensure-signed-agreement";
import {
  sendFinanceActivatedWhatsApp,
  type WhatsAppDelivery,
} from "@/lib/whatsapp/notifications";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

/**
 * Post-approval finance enablement — step 2 of 2.
 *
 * Turns financing ON for a dealer who was approved without it, once their
 * dealer agreement has been signed. This is the counterpart to the approve
 * route's `dealers.finance_enabled` write, minus everything that would disturb
 * a live dealer: no Supabase Auth work, no password regeneration, no
 * must_change_password reset, no welcome email. The dealer keeps the login they
 * already have.
 *
 * The gate mirrors approve/route.ts — agreement completed with a provider
 * document on file — so finance can never go live on an unsigned agreement.
 */
export async function POST(_req: NextRequest, context: RouteContext) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;
  try {
    const { dealerId } = await context.params;

    const [application] = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, dealerId))
      .limit(1);

    if (!application) {
      return NextResponse.json(
        { success: false, message: "Application not found" },
        { status: 404 },
      );
    }

    if (application.onboarding_status !== "approved") {
      return NextResponse.json(
        {
          success: false,
          message:
            "Only an approved dealer can have finance activated this way. " +
            "An application still under review goes live through Approve.",
        },
        { status: 400 },
      );
    }

    if (!application.finance_enabled) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Finance is not enabled on this application yet. Use Enable Finance first.",
        },
        { status: 400 },
      );
    }

    if (!application.dealer_code) {
      return NextResponse.json(
        {
          success: false,
          message:
            "This application has no dealer code, so the canonical dealer row " +
            "can't be resolved. Re-check the approval before activating finance.",
        },
        { status: 409 },
      );
    }

    // Signing gate — identical conditions to approve/route.ts:133-148.
    if (
      String(application.agreement_status || "").toLowerCase() !== "completed" ||
      !application.provider_document_id
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Finance can't be activated until the dealer agreement is completed. " +
            "Initiate the agreement, let all parties sign, then refresh its status.",
          agreementStatus: application.agreement_status || "not_generated",
        },
        { status: 400 },
      );
    }

    // Pre-flight the signed PDF the same way approve does: the signed agreement
    // is the artifact that proves signing finished, so refuse to flip the flag
    // if we can't produce it. The audit trail is supplementary — Digio's
    // download_audit_trail endpoint is intermittently flaky, so a missing audit
    // trail is logged and skipped rather than blocking activation.
    const [signedAgreementUrl, auditTrailUrl] = await Promise.all([
      ensureDealerSignedAgreementUrl(application).catch((err) => {
        console.error("ACTIVATE FINANCE — ensure signed agreement error:", err);
        return null;
      }),
      ensureDealerAuditTrailUrl(application).catch((err) => {
        console.error("ACTIVATE FINANCE — ensure audit trail error:", err);
        return null;
      }),
    ]);

    if (!signedAgreementUrl) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Signed agreement is not available yet — please retry once signing is fully complete.",
        },
        { status: 409 },
      );
    }

    if (!auditTrailUrl) {
      console.warn("ACTIVATE FINANCE — audit trail unavailable; proceeding", {
        applicationId: application.id,
      });
    }

    // The canonical flag. This is what /api/leads/create's E-105 gate and the
    // WhatsApp dealer console both read.
    //
    // Resolve the row by dealer_code, then verify it actually belongs to this
    // application before writing. A row whose application_id points at a
    // DIFFERENT application means the dealer code has been re-linked (see the
    // branch-dealer handling in approve/route.ts) and flipping it would enable
    // finance for the wrong entity. A null application_id is accepted — dealer
    // rows predating the E-106 backfill legitimately have none.
    const [dealerRow] = await db
      .select({
        id: dealers.id,
        applicationId: dealers.application_id,
        onboardingStatus: dealers.onboarding_status,
        financeEnabled: dealers.finance_enabled,
      })
      .from(dealers)
      .where(eq(dealers.dealer_id, application.dealer_code))
      .limit(1);

    if (!dealerRow) {
      return NextResponse.json(
        {
          success: false,
          message:
            `No dealer record exists for dealer code ${application.dealer_code}. ` +
            `The approval may not have completed — resolve that before activating finance.`,
        },
        { status: 409 },
      );
    }

    if (dealerRow.applicationId && dealerRow.applicationId !== application.id) {
      return NextResponse.json(
        {
          success: false,
          message:
            `Dealer code ${application.dealer_code} is linked to a different ` +
            `onboarding application. Resolve the linkage before activating finance.`,
        },
        { status: 409 },
      );
    }

    if (dealerRow.financeEnabled) {
      return NextResponse.json(
        {
          success: false,
          message: "Financing is already active for this dealer.",
          financeLive: true,
        },
        { status: 400 },
      );
    }

    await db
      .update(dealers)
      .set({ finance_enabled: true, updated_at: new Date() })
      .where(eq(dealers.id, dealerRow.id));

    await db
      .update(dealerOnboardingApplications)
      .set({ last_action_timestamp: new Date(), updated_at: new Date() })
      .where(eq(dealerOnboardingApplications.id, dealerId));

    await insertAgreementEvent({
      applicationId: dealerId,
      providerDocumentId: application.provider_document_id,
      requestId: application.request_id ?? null,
      eventType: "finance_activated_post_approval",
      eventStatus: "active",
      eventPayload: {
        activatedBy: auth.user.email ?? auth.user.id,
        dealerCode: application.dealer_code,
        signedAgreementUrl,
        auditTrailUrl,
      },
    });

    // Tell the dealer on their primary channel. Best-effort — a WhatsApp
    // failure (e.g. the 24-hour window is closed) must not undo an activation
    // that already committed.
    let whatsappDelivery: WhatsAppDelivery | null = null;
    if (
      (application.source || "web").toLowerCase() === "whatsapp" &&
      application.wa_phone
    ) {
      whatsappDelivery = await sendFinanceActivatedWhatsApp({
        waPhone: application.wa_phone,
        waSessionId: application.wa_session_id ?? null,
        dealerName:
          application.owner_name || application.company_name || "there",
        companyName: application.company_name || "your business",
        dealerCode: application.dealer_code,
        supportEmail: process.env.DEALER_SUPPORT_EMAIL || "care@itarang.com",
        supportPhone: process.env.DEALER_SUPPORT_PHONE || "+91-8076841497",
        signedAgreementUrl,
        auditTrailUrl,
      });
    }

    console.log("POST-APPROVAL FINANCE ACTIVATED:", {
      applicationId: dealerId,
      dealerCode: application.dealer_code,
      company: application.company_name,
      whatsappDelivery,
    });

    return NextResponse.json({
      success: true,
      message:
        "Financing is now active for this dealer. They can select a finance " +
        "payment method on new leads immediately.",
      financeLive: true,
      dealerCode: application.dealer_code,
      signedAgreementUrl,
      auditTrailUrl,
      whatsappDelivery,
    });
  } catch (error: any) {
    console.error("ACTIVATE FINANCE ERROR:", error);
    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Failed to activate finance",
      },
      { status: 500 },
    );
  }
}
