// POST /api/admin/whatsapp-operators/applications/[applicationId]/resend-credentials
//
// RESETS and re-sends the dealer's login. It is not a true "resend": only the
// bcrypt hash is stored, so the password issued at approval is unrecoverable.
// This mints a NEW temporary password (invalidating the old one), writes both
// password stores, and delivers over email + WhatsApp. Surface it in the UI as
// "Reset & resend credentials" so nobody expects the old password to still work.
//
// Use when the first WhatsApp send fell outside Meta's 24-hour window — the
// common case for an operator-uploaded dealer, who may never have messaged us.

import { eq } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import {
  errorResponse,
  successResponse,
  withErrorHandler,
} from "@/lib/api-utils";
import { issueTemporaryCredentials } from "@/lib/dealer/issue-temporary-credentials";
import { sendDealerWelcomeEmail } from "@/lib/email/sendDealerWelcomeEmail";
import { sendDealerWelcomeWhatsApp } from "@/lib/whatsapp/notifications";
import { bindDealerSession } from "@/lib/whatsapp/operator-handoff";

const WRITE_ROLES = ["admin", "sales_head"];

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ applicationId: string }> }) => {
    await requireRole(WRITE_ROLES);
    const { applicationId } = await ctx.params;
    if (!applicationId) return errorResponse("Application id required", 400);

    const [application] = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, applicationId))
      .limit(1);
    if (!application) return errorResponse("Application not found", 404);

    if (application.onboarding_status !== "approved") {
      return errorResponse(
        "Credentials only exist once the dealer is approved.",
        400,
      );
    }
    if (!application.dealer_user_id) {
      return errorResponse("This dealer has no login user.", 400);
    }
    const loginEmail = application.owner_email;
    if (!loginEmail) return errorResponse("This dealer has no email.", 400);

    const issued = await issueTemporaryCredentials({
      authUserId: application.dealer_user_id,
    });
    if (!issued.ok || !issued.password) {
      return errorResponse(
        `Could not reset the password: ${issued.error ?? "unknown error"}`,
        502,
      );
    }

    const origin = new URL(req.url).origin;
    const loginUrl = process.env.DEALER_LOGIN_URL || `${origin}/login`;
    const dealerName =
      application.owner_name || application.company_name || "Dealer";

    let emailSent = false;
    let emailError: string | null = null;
    try {
      await sendDealerWelcomeEmail({
        toEmail: loginEmail,
        dealerName,
        companyName: application.company_name || "iTarang Dealer",
        dealerId: application.dealer_code || "",
        userId: loginEmail,
        password: issued.password,
        loginUrl,
        supportEmail: process.env.DEALER_SUPPORT_EMAIL || "care@itarang.com",
        supportPhone: process.env.DEALER_SUPPORT_PHONE || "+91-8076841497",
      });
      emailSent = true;
    } catch (err) {
      emailError = err instanceof Error ? err.message : "email_send_failed";
      console.error("[resend-credentials] email failed:", err);
    }

    let whatsappDelivery = null;
    if (application.wa_phone) {
      const sessionId = await bindDealerSession(
        application.id,
        application.wa_phone,
        dealerName,
      ).catch(() => application.wa_session_id ?? null);

      whatsappDelivery = await sendDealerWelcomeWhatsApp({
        waPhone: application.wa_phone,
        waSessionId: sessionId,
        dealerName,
        companyName: application.company_name || "iTarang Dealer",
        dealerCode: application.dealer_code || "",
        loginId: loginEmail,
        password: issued.password,
        loginUrl,
        supportEmail: process.env.DEALER_SUPPORT_EMAIL || "care@itarang.com",
        supportPhone: process.env.DEALER_SUPPORT_PHONE || "+91-8076841497",
        // The PDFs already went out at approval; this is a credentials re-issue.
        financeEnabled: false,
      });
    }

    return successResponse({
      reset: true,
      emailSent,
      emailError,
      whatsappDelivery,
    });
  },
);
