import { NextResponse } from "next/server";
import { sendDealerWelcomeEmail } from "@/lib/email/sendDealerWelcomeEmail";
import { requireDebugAccess } from "@/lib/auth/requireDebugAccess";

// Sends a REAL email through the production mailer on a bare GET. Ungated,
// that is an open spam relay pointed at whatever TEST_EMAIL_TO holds, and a
// way to burn the sending domain's reputation. 404s in production and without
// an admin/IT session.
export async function GET() {
  const access = await requireDebugAccess();
  if (!access.ok) return access.response;

  try {
    const testEmail = process.env.TEST_EMAIL_TO;
    if (!testEmail) {
      return NextResponse.json(
        {
          success: false,
          message:
            "TEST_EMAIL_TO env var is not set. Set it in .env.local to a recipient address you control before hitting this endpoint.",
        },
        { status: 400 }
      );
    }

    const result = await sendDealerWelcomeEmail({
      toEmail: testEmail,
      dealerName: "Test Dealer",
      companyName: "Test Company Pvt Ltd",
      dealerId: "ACC-TEST-001",
      userId: "test@example.com",
      password: "Temp@12345",
      loginUrl: process.env.DEALER_LOGIN_URL || "http://localhost:3000/login",
      supportEmail: "support@itarang.com",
      supportPhone: "+91-0000000000",
    });

    return NextResponse.json({
      success: true,
      sentTo: testEmail,
      result,
    });
  } catch (error: any) {
    console.error("TEST EMAIL ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Failed to send test email",
      },
      { status: 500 }
    );
  }
}