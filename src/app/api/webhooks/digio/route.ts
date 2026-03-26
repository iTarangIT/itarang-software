import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

function normalizeDigioStatus(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function extractSignedAgreementUrl(body: any) {
  return (
    body?.signed_agreement_url ||
    body?.download_url ||
    body?.document_url ||
    body?.file_url ||
    body?.signed_file_url ||
    body?.document?.download_url ||
    body?.document?.file_url ||
    body?.agreement?.download_url ||
    body?.agreement?.file_url ||
    null
  );
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    console.log("DIGIO WEBHOOK RECEIVED:", body);

    const documentId =
      body.document_id || body.documentId || body.id || null;
    const requestId = body.request_id || body.requestId || null;
    const rawStatus = normalizeDigioStatus(body.status);
    const signedAgreementUrl = extractSignedAgreementUrl(body);

    if (!documentId) {
      return NextResponse.json(
        {
          success: false,
          message: "document_id is required in Digio webhook",
        },
        { status: 400 }
      );
    }

    let agreementStatus = "sent_for_signature";
    let reviewStatus = "agreement_in_progress";
    let signedAt: Date | null = null;

    if (rawStatus === "draft") {
      agreementStatus = "not_generated";
      reviewStatus = "under_review";
    } else if (rawStatus === "sent") {
      agreementStatus = "sent_for_signature";
      reviewStatus = "agreement_in_progress";
    } else if (rawStatus === "viewed") {
      agreementStatus = "viewed";
      reviewStatus = "agreement_in_progress";
    } else if (rawStatus === "completed" || rawStatus === "signed") {
      agreementStatus = "completed";
      reviewStatus = "agreement_completed";
      signedAt = new Date();
    } else if (rawStatus === "expired") {
      agreementStatus = "expired";
      reviewStatus = "under_review";
    } else if (rawStatus === "failed") {
      agreementStatus = "failed";
      reviewStatus = "under_review";
    } else if (rawStatus === "partially_signed" || rawStatus === "partial") {
      agreementStatus = "partially_signed";
      reviewStatus = "agreement_in_progress";
    }

    await db
      .update(dealerOnboardingApplications)
      .set({
        agreementStatus,
        reviewStatus,
        completionStatus: agreementStatus === "completed" ? "completed" : "pending",
        providerDocumentId: documentId,
        requestId,
        signedAgreementUrl:
          agreementStatus === "completed" ? signedAgreementUrl : null,
        providerRawResponse: body,
        signedAt,
        lastActionTimestamp: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(dealerOnboardingApplications.providerDocumentId, documentId));

    console.log("Webhook processed for document:", documentId);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DIGIO WEBHOOK ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: "Digio webhook processing failed",
      },
      { status: 500 }
    );
  }
}