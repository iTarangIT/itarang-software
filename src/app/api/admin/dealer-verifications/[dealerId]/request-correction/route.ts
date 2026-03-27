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

async function sendCorrectionEmail(params: {
  companyName: string;
  applicationId: string;
  correctionRemarks: string;
}) {
  try {
    const transporter = getMailer();

    const subject = `Correction Required — Dealer Onboarding Application ${params.applicationId}`;

    const html = `
      <div style="font-family: Arial, sans-serif; color: #0f172a; line-height: 1.6;">
        <h2>Correction Required — Dealer Onboarding Review</h2>
        <p>The dealer onboarding application requires corrections.</p>

        <p><strong>Dealer:</strong> ${params.companyName}</p>
        <p><strong>Application ID:</strong> ${params.applicationId}</p>

        <p><strong>Correction Remarks:</strong></p>
        <p>${params.correctionRemarks}</p>

        <p>Regards,<br/>iTarang Compliance Team</p>
      </div>
    `;

    const to = ["rushikeshkasav306@gmail.com"];

    const info = await transporter.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: to.join(","),
      subject,
      html,
    });

    console.log("CORRECTION EMAIL SENT:", info.messageId);

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

    const emailResult = await sendCorrectionEmail({
      companyName: application.companyName || "Unknown Company",
      applicationId: String(application.id),
      correctionRemarks: remarks,
    });

    return NextResponse.json({
      success: true,
      message: emailResult.success
        ? "Correction request sent"
        : "Correction saved but email failed",
    });
  } catch (error: any) {
    console.error("REQUEST CORRECTION ERROR:", error);

    return NextResponse.json(
      { success: false, message: error?.message || "Error" },
      { status: 500 }
    );
  }
}