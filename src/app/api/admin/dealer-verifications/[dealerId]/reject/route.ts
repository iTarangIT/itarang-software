import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { sendDealerRejectionNotificationEmail } from "@/lib/email/sendDealerRejectionNotificationEmail";
import { getDealerNotificationRecipients } from "@/lib/email/dealer-notification-recipients";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";

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
        onboardingStatus: "rejected",
        reviewStatus: "rejected",
        dealerAccountStatus: "inactive",
        completionStatus: "pending",
        rejectedAt: new Date(),
        rejectionReason: remarks,
        rejectionRemarks: remarks,
        correctionRemarks: null,
        updatedAt: new Date(),
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
      salesManagerEmail: maskEmail(application.salesManagerEmail),
      itarangSignatory1Email: maskEmail(application.itarangSignatory1Email),
      itarangSignatory2Email: maskEmail(application.itarangSignatory2Email),
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
          companyName: application.companyName || "Unknown Company",
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

    return NextResponse.json({
      success: true,
      message: emailResult.ok
        ? "Dealer rejected and notification sent"
        : "Dealer rejected but email failed",
      notificationRecipients,
      emailResult,
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