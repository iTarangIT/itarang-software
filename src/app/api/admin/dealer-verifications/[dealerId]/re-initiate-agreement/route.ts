import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { canReInitiateAgreement } from "@/lib/agreement/status";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import { POST as initiateAgreement } from "@/app/api/admin/dealer-verifications/[dealerId]/initiate-agreement/route";

type Context = {
  params: Promise<{ dealerId: string }>;
};

export async function POST(req: NextRequest, context: Context) {
  const auth = await requireSalesHead();
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

    // Call initiate-agreement in-process. We previously did a self-fetch via
    // APP_URL / NEXT_PUBLIC_APP_URL, which fails on Hostinger when those are
    // unset or point somewhere unreachable (e.g. a stale ngrok tunnel).
    // In-process avoids the network hop entirely and preserves the caller's
    // auth context because requireSalesHead() reads the same Supabase session
    // cookies from the forwarded NextRequest.
    const forwardHeaders = new Headers(req.headers);
    forwardHeaders.set("Content-Type", "application/json");
    const internalReq = new NextRequest(
      new Request(`${req.nextUrl.origin}/api/admin/dealer-verifications/${dealerId}/initiate-agreement`, {
        method: "POST",
        headers: forwardHeaders,
        body: JSON.stringify(body),
      })
    );
    const response = await initiateAgreement(internalReq, {
      params: Promise.resolve({ dealerId }),
    });

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