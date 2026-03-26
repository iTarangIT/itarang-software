import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import {
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

function parseProviderRawResponse(value: unknown) {
  if (!value) return {};

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }

  if (typeof value === "object") {
    return value as Record<string, any>;
  }

  return {};
}

export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    const { dealerId } = await context.params;

    const application = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, dealerId));

    const row = application[0];

    if (!row) {
      return NextResponse.json(
        {
          success: false,
          message: "Dealer onboarding application not found",
        },
        { status: 404 }
      );
    }

    const uploadedDocuments = await db
      .select()
      .from(dealerOnboardingDocuments)
      .where(eq(dealerOnboardingDocuments.applicationId, row.id));

    const documents = uploadedDocuments.map((doc) => ({
      id: doc.id,
      name: doc.fileName || doc.documentType,
      documentType: doc.documentType,
      url: doc.fileUrl || "",
      docStatus: doc.docStatus,
      verificationStatus: doc.verificationStatus,
      uploadedAt: doc.uploadedAt,
      rejectionReason: doc.rejectionReason,
    }));

    const providerData = parseProviderRawResponse(row.providerRawResponse);
    const agreementData = providerData?.agreement || {};

    return NextResponse.json({
      success: true,
      data: {
        id: row.id,
        dealerId: row.id,
        companyName: row.companyName,
        gstNumber: row.gstNumber,
        panNumber: row.panNumber,
        companyType: row.companyType,
        financeEnabled: row.financeEnabled,
        onboardingStatus: row.onboardingStatus,
        reviewStatus: row.reviewStatus,
        submittedAt: row.submittedAt,
        ownerName: row.ownerName,
        ownerPhone: row.ownerPhone,
        ownerEmail: row.ownerEmail,
        documents,

        agreement: row.financeEnabled
          ? {
            agreementId: row.providerDocumentId || null,
            status: row.agreementStatus || "not_generated",
            copyUrl: row.providerSigningUrl || null,
            signedAgreementUrl: row.signedAgreementUrl || null,
            requestId: row.requestId || null,
            stampStatus: row.stampStatus || "pending",
            completionStatus: row.completionStatus || "pending",
            signedAt: row.signedAt || null,
            lastActionTimestamp: row.lastActionTimestamp || null,

            // IMPORTANT — STEP 5 DATA
            agreementName: agreementData.agreementName || "",
            agreementVersion: agreementData.agreementVersion || "",
            dateOfSigning: agreementData.dateOfSigning || "",
            mouDate: agreementData.mouDate || "",
            financierName: agreementData.financierName || "",

            dealerSignerName: agreementData.dealerSignerName || "",
            dealerSignerDesignation:
              agreementData.dealerSignerDesignation || "",
            dealerSignerEmail: agreementData.dealerSignerEmail || "",
            dealerSignerPhone: agreementData.dealerSignerPhone || "",
            dealerSigningMethod:
              agreementData.dealerSigningMethod || "",

            financierSignatory:
              agreementData.financierSignatory || null,
            itarangSignatory1:
              agreementData.itarangSignatory1 || null,
            itarangSignatory2:
              agreementData.itarangSignatory2 || null,

            signingOrder:
              agreementData.signingOrder || [
                "dealer",
                "financier",
                "itarang_1",
                "itarang_2",
              ],

            isOemFinancing: !!agreementData.isOemFinancing,
            vehicleType: agreementData.vehicleType || "",
            manufacturer: agreementData.manufacturer || "",
            brand: agreementData.brand || "",
            statePresence: agreementData.statePresence || "",
          }
          : null,
      },
    });
  } catch (error: any) {
    console.error("ADMIN DEALER VERIFICATION DETAIL ERROR FULL:", error);
    console.error("ADMIN DEALER VERIFICATION DETAIL ERROR MESSAGE:", error?.message);
    console.error("ADMIN DEALER VERIFICATION DETAIL ERROR CAUSE:", error?.cause);
    console.error("ADMIN DEALER VERIFICATION DETAIL ERROR DETAIL:", error?.cause?.detail);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Failed to fetch dealer verification detail",
      },
      { status: 500 }
    );
  }
}