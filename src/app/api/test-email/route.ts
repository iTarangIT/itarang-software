import { NextResponse } from "next/server";
import { sendDealerWelcomeEmail } from "@/lib/email/sendDealerWelcomeEmail";

export async function GET() {
  try {
    const testEmail =
      process.env.TEST_EMAIL_TO || "rushikeshkasav306@gmail.com";

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