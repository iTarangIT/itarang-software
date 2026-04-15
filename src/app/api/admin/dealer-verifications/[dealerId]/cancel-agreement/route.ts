import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { insertAgreementEvent } from "@/lib/agreement/tracking";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

function cleanEnv(value?: string) {
  return value?.trim().replace(/^[\"']|[\"']$/g, "");
}

function basicAuthHeader(clientId: string, clientSecret: string) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

export async function POST(_req: NextRequest, context: RouteContext) {
  try {
    const { dealerId } = await context.params;

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

    if (!application.providerDocumentId) {
      return NextResponse.json(
        { success: false, message: "No agreement to cancel — agreement not initiated yet." },
        { status: 400 }
      );
    }

    const currentStatus = String(application.agreementStatus || "").toLowerCase();
    if (currentStatus === "completed") {
      return NextResponse.json(
        { success: false, message: "Cannot cancel a completed agreement." },
        { status: 400 }
      );
    }

    const clientId = cleanEnv(process.env.DIGIO_CLIENT_ID);
    const clientSecret = cleanEnv(process.env.DIGIO_CLIENT_SECRET);
    const baseUrl = cleanEnv(process.env.DIGIO_BASE_URL) || "https://ext.digio.in:444";

    if (!clientId || !clientSecret) {
      return NextResponse.json(
        { success: false, message: "Missing Digio credentials" },
        { status: 500 }
      );
    }

    const cancelUrl = `${baseUrl}/v2/client/document/${encodeURIComponent(application.providerDocumentId)}/cancel`;

    const digioResponse = await fetch(cancelUrl, {
      method: "GET",
      headers: {
        Authorization: basicAuthHeader(clientId, clientSecret),
        Accept: "application/json",
      },
      cache: "no-store",
    });

    const rawText = await digioResponse.text();

    let parsed: any = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = null;
    }

    if (!digioResponse.ok) {
      return NextResponse.json(
        {
          success: false,
          message: parsed?.message || parsed?.error_msg || "Failed to cancel agreement on Digio",
          raw: parsed || rawText,
        },
        { status: digioResponse.status }
      );
    }

    await db
      .update(dealerOnboardingApplications)
      .set({
        agreementStatus: "failed",
        completionStatus: "pending",
        reviewStatus: "pending_admin_review",
        providerRawResponse: parsed || {},
        lastActionTimestamp: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(dealerOnboardingApplications.id, dealerId));

    await insertAgreementEvent({
      applicationId: dealerId,
      providerDocumentId: application.providerDocumentId,
      requestId: application.requestId || null,
      eventType: "cancelled",
      eventStatus: "failed",
      eventPayload: parsed || {},
    });

    return NextResponse.json({
      success: true,
      message: "Agreement cancelled successfully",
      raw: parsed,
    });
  } catch (error: any) {
    console.error("CANCEL AGREEMENT ERROR:", error);

    return NextResponse.json(
      { success: false, message: error?.message || "Failed to cancel agreement" },
      { status: 500 }
    );
  }
}
