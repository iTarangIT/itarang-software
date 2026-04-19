import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { canReInitiateAgreement } from "@/lib/agreement/status";
import { requireAdmin } from "@/lib/auth/requireAdmin";

type Context = {
  params: Promise<{ dealerId: string }>;
};

export async function POST(req: NextRequest, context: Context) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  try {
    const { dealerId } = await context.params;

    const rows = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, dealerId))
      .limit(1);

    const application = rows[0];

    if (!application) {
      return NextResponse.json(
        { success: false, message: "Application not found" },
        { status: 404 }
      );
    }

    if (!canReInitiateAgreement(application.agreementStatus)) {
      return NextResponse.json(
        {
          success: false,
          message: "Agreement can only be re-initiated when status is FAILED or EXPIRED",
        },
        { status: 400 }
      );
    }

    const body = await req.json();

    if (!body?.agreementConfig) {
      return NextResponse.json(
        {
          success: false,
          message: "agreementConfig is required for re-initiation",
        },
        { status: 400 }
      );
    }

    const appBaseUrl =
      process.env.APP_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      "http://localhost:3000";

    // Forward caller auth (cookies + Authorization) to the internal POST —
    // without this, initiate-agreement's requireAdmin() gate returns 401 and
    // the re-initiate flow appears broken for every authenticated admin.
    const forwardHeaders: Record<string, string> = { "Content-Type": "application/json" };
    const cookieHeader = req.headers.get("cookie");
    if (cookieHeader) forwardHeaders.cookie = cookieHeader;
    const authHeader = req.headers.get("authorization");
    if (authHeader) forwardHeaders.authorization = authHeader;

    const response = await fetch(
      `${appBaseUrl}/api/admin/dealer-verifications/${dealerId}/initiate-agreement`,
      {
        method: "POST",
        headers: forwardHeaders,
        body: JSON.stringify(body),
      }
    );

    const json = await response.json();

    if (!response.ok) {
      return NextResponse.json(json, { status: response.status });
    }

    return NextResponse.json({
      success: true,
      message: "Agreement re-initiated successfully",
      data: json?.data || null,
    });
  } catch (error: any) {
    console.error("RE-INITIATE AGREEMENT ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Failed to re-initiate agreement",
      },
      { status: 500 }
    );
  }
}