import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import {
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
} from "@/lib/db/schema";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const {
      dealerUserId,
      companyName,
      companyType,
      gstNumber,
      panNumber,
      cinNumber,
      businessAddress,
      registeredAddress,
      financeEnabled,
      onboardingStatus,
      ownerName,
      ownerPhone,
      ownerEmail,
      bankName,
      accountNumber,
      beneficiaryName,
      ifscCode,
      documents,
    } = body;

    if (!companyName) {
      return NextResponse.json(
        { success: false, message: "Company name is required" },
        { status: 400 }
      );
    }

    const insertedApplications = await db
      .insert(dealerOnboardingApplications)
      .values({
        dealerUserId: dealerUserId ?? null,
        companyName,
        companyType: companyType ?? null,
        gstNumber: gstNumber ?? null,
        panNumber: panNumber ?? null,
        cinNumber: cinNumber ?? null,
        businessAddress: businessAddress ?? {},
        registeredAddress: registeredAddress ?? {},
        financeEnabled: financeEnabled ?? false,
        onboardingStatus: onboardingStatus ?? "draft",
        submittedAt: onboardingStatus === "submitted" ? new Date() : null,
        ownerName: ownerName ?? null,
        ownerPhone: ownerPhone ?? null,
        ownerEmail: ownerEmail ?? null,
        bankName: bankName ?? null,
        accountNumber: accountNumber ?? null,
        beneficiaryName: beneficiaryName ?? null,
        ifscCode: ifscCode ?? null,
      })
      .returning();

    const application = insertedApplications[0];

    if (Array.isArray(documents) && documents.length > 0) {
      const validDocuments = documents
        .filter(
          (doc: any) =>
            doc?.documentType &&
            doc?.bucketName &&
            doc?.storagePath &&
            doc?.fileName
        )
        .map((doc: any) => ({
          applicationId: application.id,
          documentType: doc.documentType,
          bucketName: doc.bucketName,
          storagePath: doc.storagePath,
          fileName: doc.fileName,
          fileUrl: doc.fileUrl ?? null,
          mimeType: doc.mimeType ?? null,
          fileSize: typeof doc.fileSize === "number" ? doc.fileSize : null,
          uploadedBy: dealerUserId ?? null,
          docStatus: doc.docStatus ?? "uploaded",
          verificationStatus: doc.verificationStatus ?? "pending",
          metadata: doc.metadata ?? {},
        }));

      if (validDocuments.length > 0) {
        await db.insert(dealerOnboardingDocuments).values(validDocuments);
      }
    }

    return NextResponse.json({
      success: true,
      application,
    });
  } catch (error: any) {
    console.error("SAVE ONBOARDING ERROR FULL:", error);
    console.error("SAVE ONBOARDING ERROR MESSAGE:", error?.message);
    console.error("SAVE ONBOARDING ERROR CAUSE:", error?.cause);
    console.error("SAVE ONBOARDING ERROR DETAIL:", error?.cause?.detail);
    console.error("SAVE ONBOARDING ERROR CODE:", error?.cause?.code);

    return NextResponse.json(
      {
        success: false,
        message:
          error?.cause?.message ||
          error?.message ||
          "Failed to save onboarding application",
      },
      { status: 500 }
    );
  }
}