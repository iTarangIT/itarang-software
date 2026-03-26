import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

function cleanEnv(value?: string) {
  return value?.trim().replace(/^[\"']|[\"']$/g, "");
}

function basicAuthHeader(clientId: string, clientSecret: string) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

function normalizeAgreementStatus(rawStatus?: string | null) {
  const status = String(rawStatus || "")
    .trim()
    .toLowerCase();

  if (["completed", "signed"].includes(status)) {
    return "completed";
  }

  if (["partially_signed", "partial"].includes(status)) {
    return "partially_signed";
  }

  if (["expired"].includes(status)) {
    return "expired";
  }

  if (["failed", "cancelled", "rejected"].includes(status)) {
    return "failed";
  }

  if (
    [
      "created",
      "pending",
      "sent",
      "sent_for_signature",
      "viewed",
      "in_progress",
    ].includes(status)
  ) {
    return "sent_for_signature";
  }

  return "sent_for_signature";
}

function extractSigningUrl(parsed: any) {
  const signingParties = Array.isArray(parsed?.signing_parties)
    ? parsed.signing_parties
    : [];

  const dealerParty =
    signingParties.find(
      (party: any) =>
        String(party?.reason || "").toLowerCase() === "dealer signer"
    ) || signingParties[0];

  return (
    dealerParty?.authentication_url ||
    parsed?.signing_url ||
    parsed?.sign_url ||
    parsed?.redirect_url ||
    parsed?.authentication_url ||
    null
  );
}

function extractSignedAgreementUrl(parsed: any) {
  return (
    parsed?.signed_agreement_url ||
    parsed?.executed_file_url ||
    parsed?.file_url ||
    parsed?.download_url ||
    parsed?.document_url ||
    null
  );
}

function extractSignedAt(parsed: any) {
  return (
    parsed?.signed_at ||
    parsed?.completed_at ||
    parsed?.execution_date ||
    null
  );
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
        {
          success: false,
          message: "Application not found",
        },
        { status: 404 }
      );
    }

    if (!application.financeEnabled) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Agreement refresh is only available for finance-enabled applications.",
        },
        { status: 400 }
      );
    }

    if (!application.providerDocumentId) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Agreement has not been initiated yet. Please initiate agreement first.",
        },
        { status: 400 }
      );
    }

    const clientId = cleanEnv(process.env.DIGIO_CLIENT_ID);
    const clientSecret = cleanEnv(process.env.DIGIO_CLIENT_SECRET);
    const baseUrl =
      cleanEnv(process.env.DIGIO_BASE_URL) || "https://ext.digio.in:444";

    if (!clientId || !clientSecret) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Missing Digio configuration. Set DIGIO_CLIENT_ID and DIGIO_CLIENT_SECRET.",
        },
        { status: 500 }
      );
    }

    const digioUrl = `${baseUrl}/v2/client/document/${application.providerDocumentId}`;

    const digioResponse = await fetch(digioUrl, {
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
          message:
            parsed?.message ||
            parsed?.error_msg ||
            parsed?.error ||
            "Failed to fetch agreement status from Digio",
          raw: parsed || rawText,
        },
        { status: digioResponse.status }
      );
    }

    const normalizedStatus = normalizeAgreementStatus(
      parsed?.agreement_status || parsed?.status
    );

    const signingUrl = extractSigningUrl(parsed);
    const signedAgreementUrl =
      extractSignedAgreementUrl(parsed) || application.signedAgreementUrl || null;

    const signedAtValue = extractSignedAt(parsed);
    const signedAt =
      normalizedStatus === "completed"
        ? signedAtValue
          ? new Date(signedAtValue)
          : application.signedAt || new Date()
        : application.signedAt || null;

    const completionStatus =
      normalizedStatus === "completed" ? "completed" : "pending";

    const reviewStatus =
      normalizedStatus === "completed"
        ? "agreement_completed"
        : "agreement_in_progress";

    await db
      .update(dealerOnboardingApplications)
      .set({
        agreementStatus: normalizedStatus,
        providerSigningUrl: signingUrl,
        signedAgreementUrl,
        providerRawResponse: parsed || {},
        completionStatus,
        reviewStatus,
        signedAt,
        stampStatus:
          parsed?.stamp_status ||
          parsed?.stampStatus ||
          application.stampStatus ||
          "pending",
        lastActionTimestamp: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(dealerOnboardingApplications.id, dealerId));

    return NextResponse.json({
      success: true,
      message: "Agreement status refreshed successfully",
      data: {
        agreementStatus: normalizedStatus,
        reviewStatus,
        requestId: application.requestId || null,
        providerDocumentId: application.providerDocumentId || null,
        providerSigningUrl: signingUrl,
        signedAgreementUrl,
        stampStatus:
          parsed?.stamp_status ||
          parsed?.stampStatus ||
          application.stampStatus ||
          "pending",
        completionStatus,
        signedAt,
        lastActionTimestamp: new Date(),
        raw: parsed || null,
      },
    });
  } catch (error: any) {
    console.error("REFRESH AGREEMENT ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Failed to refresh agreement status",
      },
      { status: 500 }
    );
  }
}