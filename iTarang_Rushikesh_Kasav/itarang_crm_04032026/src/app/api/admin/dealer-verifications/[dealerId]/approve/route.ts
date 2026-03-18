import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { dealerOnboardingApplications, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { generateTemporaryPassword } from "@/lib/auth/generateTemporaryPassword";
import { hashPassword } from "@/lib/auth/hashPassword";
import { sendDealerWelcomeEmail } from "@/lib/email/sendDealerWelcomeEmail";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

function generateDealerCode() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const random = Math.floor(100 + Math.random() * 900);

  return `ACC-ITARANG-${yyyy}${mm}${dd}-${random}`;
}

export async function POST(_req: NextRequest, context: RouteContext) {
  try {
    const { dealerId } = await context.params;

    const existing = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, dealerId));

    const application = existing[0];

    if (!application) {
      return NextResponse.json(
        {
          success: false,
          message: "Dealer onboarding application not found",
        },
        { status: 404 }
      );
    }

    const dealerCode = application.dealerCode || generateDealerCode();

    const dealerLoginEmail = application.ownerEmail?.trim() || null;

    if (!dealerLoginEmail) {
      return NextResponse.json(
        {
          success: false,
          message: "Dealer owner email is missing. Cannot create login credentials.",
        },
        { status: 400 }
      );
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);

    await db
      .update(dealerOnboardingApplications)
      .set({
        onboardingStatus: "approved",
        reviewStatus: "approved",
        dealerAccountStatus: "active",
        approvedAt: new Date(),
        rejectedAt: null,
        rejectionReason: null,
        correctionRemarks: null,
        rejectionRemarks: null,
        dealerCode,
        updatedAt: new Date(),
      })
      .where(eq(dealerOnboardingApplications.id, dealerId));

    const existingUserRows = await db
      .select()
      .from(users)
      .where(eq(users.email, dealerLoginEmail));

    const existingUser = existingUserRows[0];

    if (existingUser) {
      await db
        .update(users)
        .set({
          name: application.ownerName || application.companyName,
          role: "dealer",
          dealer_id: dealerCode,
          phone: application.ownerPhone || null,
          is_active: true,
          password_hash: passwordHash,
          must_change_password: true,
          updated_at: new Date(),
        })
        .where(eq(users.id, existingUser.id));
    } else {
      await db.insert(users).values({
        id: crypto.randomUUID(),
        email: dealerLoginEmail,
        name: application.ownerName || application.companyName,
        role: "dealer",
        dealer_id: dealerCode,
        phone: application.ownerPhone || null,
        avatar_url: null,
        password_hash: passwordHash,
        must_change_password: true,
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }

    await sendDealerWelcomeEmail({
      dealerName: application.ownerName || application.companyName,
      companyName: application.companyName,
      dealerId: dealerCode,
      userId: dealerLoginEmail,
      password: temporaryPassword,
      loginUrl: process.env.DEALER_LOGIN_URL || "https://crm.itarang.com/login",
      supportEmail: process.env.DEALER_SUPPORT_EMAIL || "support@itarang.com",
      supportPhone: process.env.DEALER_SUPPORT_PHONE || "+91-XXXXXXXXXX",
    });

    return NextResponse.json({
      success: true,
      message: "Dealer approved successfully and welcome email sent",
      dealerCode,
    });
  } catch (error: any) {
    console.error("APPROVE DEALER ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Approve failed",
      },
      { status: 500 }
    );
  }
}