import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import nodemailer from "nodemailer";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

function cleanString(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function getMailer() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error("Missing SMTP configuration in environment variables");
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {
      user,
      pass,
    },
  });
}

async function sendRejectionEmail(params: {
  companyName: string;
  applicationId: string;
  rejectionRemarks: string;
}) {
  try {
    const transporter = getMailer();

    const subject = `Dealer Onboarding Rejected — ${params.applicationId}`;

    const html = `
      <div style="font-family: Arial, sans-serif; color: #0f172a; line-height: 1.6;">
        <h2 style="margin-bottom: 8px;">Dealer Onboarding Rejected</h2>
        <p>A dealer onboarding application has been rejected after admin review.</p>

        <div style="margin-top: 16px; padding: 16px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px;">
          <p><strong>Dealer / Company:</strong> ${params.companyName}</p>
          <p><strong>Application ID:</strong> ${params.applicationId}</p>
          <p><strong>Current Status:</strong> Rejected</p>
        </div>

        <div style="margin-top: 16px; padding: 16px; background: #fef2f2; border: 1px solid #fca5a5; border-radius: 12px;">
          <p style="margin: 0 0 8px 0;"><strong>Rejection Reason</strong></p>
          <p style="white-space: pre-line; margin: 0;">${params.rejectionRemarks}</p>
        </div>

        <p style="margin-top: 16px;">
          This application is now locked and is no longer editable.
        </p>

        <p style="margin-top: 16px;">
          Please review the rejection details and take the required business follow-up action.
        </p>

        <p style="margin-top: 16px;">Regards,<br/>iTarang Compliance / Admin Team</p>
      </div>
    `;

    const to = ["rushikeshkasav306@gmail.com"];

    const info = await transporter.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: to.join(","),
      subject,
      html,
    });

    console.log("REJECTION EMAIL SENT:", {
      messageId: info.messageId,
      to,
      subject,
    });

    return { success: true };
  } catch (error) {
    console.error("SEND REJECTION EMAIL ERROR:", error);
    return { success: false };
  }
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const { dealerId } = await context.params;
    const body = await req.json();

    const remarks = cleanString(body?.remarks);

    if (!remarks) {
      return NextResponse.json(
        {
          success: false,
          message: "Rejection remarks are required",
        },
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
        {
          success: false,
          message: "Dealer onboarding application not found",
        },
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

    const emailResult = await sendRejectionEmail({
      companyName: application.companyName || "Unknown Company",
      applicationId: String(application.id),
      rejectionRemarks: remarks,
    });

    console.log("DEALER REJECTED:", {
      dealerId,
      companyName: application.companyName,
      remarks,
      rejectedAt: new Date().toISOString(),
      emailSent: emailResult.success,
    });

    return NextResponse.json({
      success: true,
      message: emailResult.success
        ? "Dealer application rejected successfully"
        : "Dealer rejected, but email sending failed",
      data: {
        dealerId,
        onboardingStatus: "rejected",
        reviewStatus: "rejected",
        rejectionRemarks: remarks,
        formEditable: false,
        emailSent: emailResult.success,
      },
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