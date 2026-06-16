import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import {
  dealerOnboardingApplications,
  whatsappOnboardingSessions,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { sendDealerRejectionNotificationEmail } from "@/lib/email/sendDealerRejectionNotificationEmail";
import { getDealerNotificationRecipients } from "@/lib/email/dealer-notification-recipients";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import {
  sendDealerRejectedWhatsApp,
  type WhatsAppDelivery,
} from "@/lib/whatsapp/notifications";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

function cleanString(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim();
}

export async function POST(req: NextRequest, context: RouteContext) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;
  try {
    const { dealerId } = await context.params;
    const body = await req.json();

    const remarks = cleanString(body?.remarks);

    if (!remarks) {
      return NextResponse.json(
        { success: false, message: "Rejection remarks are required" },
        { status: 400 }
      );
    }

    const applicationRows = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, dealerId))
      .limit(1);

    const application = applicationRows[0];

    if (!application) {
      return NextResponse.json(
        { success: false, message: "Dealer onboarding application not found" },
        { status: 404 }
      );
    }

    await db
      .update(dealerOnboardingApplications)
      .set({
        onboarding_status: "rejected",
        review_status: "rejected",
        dealer_account_status: "inactive",
        completion_status: "pending",
        rejected_at: new Date(),
        rejection_reason: remarks,
        rejection_remarks: remarks,
        correction_remarks: null,
        updated_at: new Date(),
      })
      .where(eq(dealerOnboardingApplications.id, dealerId));

    const notificationRecipients = await getDealerNotificationRecipients(application, {
      includeDealer: true,
    });

    const maskEmail = (e: unknown): string | null => {
      if (typeof e !== "string" || !e.includes("@")) return null;
      const [local, domain] = e.split("@");
      return `${local.charAt(0) || "*"}***@${domain}`;
    };
    console.log("REJECT recipients:", {
      dealerId,
      applicationId: application.id,
      salesManagerEmail: maskEmail(application.sales_manager_email),
      itarangSignatory1Email: maskEmail(application.itarang_signatory_1_email),
      itarangSignatory2Email: maskEmail(application.itarang_signatory_2_email),
      notificationRecipientsCount: notificationRecipients.length,
    });

    let emailResult: { ok: boolean; messageId?: string; recipients?: string[]; error?: string; message?: string };
    if (notificationRecipients.length === 0) {
      emailResult = {
        ok: false,
        error: "no_recipients",
        message: "No notification recipients resolved for this application",
      };
    } else {
      try {
        emailResult = await sendDealerRejectionNotificationEmail({
          toEmails: notificationRecipients,
          companyName: application.company_name || "Unknown Company",
          applicationId: String(application.id),
          rejectionRemarks: remarks,
        });
      } catch (emailError: any) {
        console.error("REJECT DEALER EMAIL ERROR:", emailError);
        emailResult = {
          ok: false,
          error: "send_failed",
          message: emailError?.message || "Failed to send rejection email",
        };
      }
    }

    // WhatsApp-onboarded dealers also get the rejection over WhatsApp (their
    // primary channel). Best-effort, additive to the email. Also flip their
    // session to REJECTED so a later "hi" gets the right reply instead of the
    // "under review" message or a restarted onboarding.
    let whatsappDelivery: WhatsAppDelivery | null = null;
    if (
      (application.source || "web").toLowerCase() === "whatsapp" &&
      application.wa_phone
    ) {
      whatsappDelivery = await sendDealerRejectedWhatsApp({
        waPhone: application.wa_phone,
        waSessionId: application.wa_session_id ?? null,
        dealerName:
          application.owner_name || application.company_name || "Dealer",
        companyName: application.company_name || "your company",
        remarks,
        supportEmail: process.env.DEALER_SUPPORT_EMAIL || "care@itarang.com",
        supportPhone: process.env.DEALER_SUPPORT_PHONE || "+91-8076841497",
      });
      try {
        await db
          .update(whatsappOnboardingSessions)
          .set({
            current_state: "REJECTED",
            session_status: "closed",
            updated_at: new Date(),
          })
          .where(eq(whatsappOnboardingSessions.application_id, dealerId));
      } catch (sessErr) {
        console.error("REJECT — could not close WhatsApp session:", sessErr);
      }
      console.log("DEALER REJECT WHATSAPP:", { dealerId, whatsappDelivery });
    }

    return NextResponse.json({
      success: true,
      message: emailResult.ok
        ? "Dealer rejected and notification sent"
        : "Dealer rejected but email failed",
      notificationRecipients,
      emailResult,
      whatsappDelivery,
    });
  } catch (error: any) {
    console.error("REJECT DEALER ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Reject failed",
      },
      { status: 500 }
    );
  }
}