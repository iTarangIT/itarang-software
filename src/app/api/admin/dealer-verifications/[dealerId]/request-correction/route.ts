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

function cleanEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function getNotificationRecipients(application: any) {
  const recipients = [
    cleanEmail(application?.salesManagerEmail),
    cleanEmail(application?.itarangSignatory1Email),
    cleanEmail(application?.itarangSignatory2Email),
  ].filter(Boolean);

  return Array.from(new Set(recipients));
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

async function sendCorrectionEmail(params: {
  to: string[];
  companyName: string;
  applicationId: string;
  correctionRemarks: string;
}) {
  try {
    if (!params.to.length) {
      console.warn("No correction email recipients provided");
      return { success: false };
    }

    const transporter = getMailer();

    const subject = `Correction Required — Dealer Onboarding Application ${params.applicationId}`;

    const html = `
      <div style="font-family: Arial, sans-serif; color: #0f172a; line-height: 1.6;">
        <h2>Correction Required — Dealer Onboarding Review</h2>
        <p>The dealer onboarding application requires corrections.</p>

        <p><strong>Dealer:</strong> ${params.companyName}</p>
        <p><strong>Application ID:</strong> ${params.applicationId}</p>
        <p><strong>Status:</strong> Correction Requested</p>

        <p><strong>Correction Remarks:</strong></p>
        <p>${params.correctionRemarks}</p>

        <p>Please coordinate internally and take the necessary corrective action.</p>

        <p>Regards,<br/>iTarang Compliance Team</p>
      </div>
    `;

    const info = await transporter.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: params.to.join(","),
      subject,
      html,
    });

    console.log("CORRECTION EMAIL SENT:", {
      messageId: info.messageId,
      recipients: params.to,
      applicationId: params.applicationId,
    });

    return { success: true };
  } catch (error) {
    console.error("SEND CORRECTION EMAIL ERROR:", error);
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
        { success: false, message: "Correction remarks are required" },
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
        { success: false, message: "Application not found" },
        { status: 404 }
      );
    }

    await db
      .update(dealerOnboardingApplications)
      .set({
        onboardingStatus: "correction_requested",
        reviewStatus: "under_correction",
        dealerAccountStatus: "inactive",
        completionStatus: "pending",
        correctionRemarks: remarks,
        updatedAt: new Date(),
      })
      .where(eq(dealerOnboardingApplications.id, dealerId));

    const notificationRecipients = getNotificationRecipients(application);

    if (notificationRecipients.length === 0) {
      console.warn("No correction notification recipients found for application:", {
        dealerId,
        applicationId: application.id,
      });
    }

    const emailResult = await sendCorrectionEmail({
      to: notificationRecipients,
      companyName: application.companyName || "Unknown Company",
      applicationId: String(application.id),
      correctionRemarks: remarks,
    });

    return NextResponse.json({
      success: true,
      message: emailResult.success
        ? "Correction request sent"
        : "Correction saved but email failed",
      notificationRecipients,
    });
  } catch (error: any) {
    console.error("REQUEST CORRECTION ERROR:", error);

    return NextResponse.json(
      { success: false, message: error?.message || "Error" },
      { status: 500 }
    );
  }
}