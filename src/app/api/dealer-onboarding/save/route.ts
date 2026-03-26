import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import {
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";

function cleanString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const dealerUserId = body.dealerUserId ?? null;
    const companyName = cleanString(body.companyName);
    const companyType = cleanString(body.companyType);
    const gstNumber = cleanString(body.gstNumber);
    const panNumber = cleanString(body.panNumber);
    const cinNumber = cleanString(body.cinNumber);
    const businessAddress = body.businessAddress ?? {};
    const registeredAddress = body.registeredAddress ?? {};
    const financeEnabled = body.financeEnabled ?? false;

    // Final submit from StepReview should send "submitted"
    const onboardingStatus =
      body.onboardingStatus === "submitted" ? "submitted" : "draft";

    const reviewStatus =
      onboardingStatus === "submitted" ? "pending_sales_head" : null;

    const ownerName = cleanString(body.ownerName);
    const ownerPhone = cleanString(body.ownerPhone);
    const ownerEmail = cleanString(body.ownerEmail);

    const bankName = cleanString(body.bankName);
    const accountNumber = cleanString(body.accountNumber);
    const beneficiaryName = cleanString(body.beneficiaryName);
    const ifscCode = cleanString(body.ifscCode);

    const documents = Array.isArray(body.documents) ? body.documents : [];
    const agreementConfig = body.agreement ?? {};
    if (!companyName) {
      return NextResponse.json(
        { success: false, message: "Company name is required" },
        { status: 400 }
      );
    }

    if (onboardingStatus === "submitted") {
      if (!ownerName) {
        return NextResponse.json(
          {
            success: false,
            message: "Primary contact name is required before submission",
          },
          { status: 400 }
        );
      }

      if (!ownerPhone) {
        return NextResponse.json(
          {
            success: false,
            message: "Primary contact phone is required before submission",
          },
          { status: 400 }
        );
      }

      if (!ownerEmail) {
        return NextResponse.json(
          {
            success: false,
            message: "Primary contact email is required before submission",
          },
          { status: 400 }
        );
      }
    }

    let application:
      | typeof dealerOnboardingApplications.$inferSelect
      | undefined;

    // Update existing application if dealer already has one
    if (dealerUserId) {
      const existing = await db
        .select()
        .from(dealerOnboardingApplications)
        .where(eq(dealerOnboardingApplications.dealerUserId, dealerUserId))
        .limit(1);

      if (existing.length > 0) {
        const updatedApplications = await db
          .update(dealerOnboardingApplications)
          .set({
            companyName,
            companyType,
            gstNumber,
            panNumber,
            cinNumber,
            businessAddress,
            registeredAddress,
            financeEnabled,
            onboardingStatus,
            reviewStatus,
            submittedAt: onboardingStatus === "submitted" ? new Date() : null,
            ownerName,
            ownerPhone,
            ownerEmail,
            bankName,
            accountNumber,
            beneficiaryName,
            ifscCode,
            updatedAt: new Date(),

            agreementStatus:
              onboardingStatus === "submitted"
                ? "not_generated"
                : agreementConfig?.agreementStatus || "not_generated",

            providerSigningUrl: null,
            providerDocumentId: null,
            requestId: null,

            // SAVE STEP 5 AGREEMENT DATA HERE
            providerRawResponse: {
              agreement: agreementConfig,
            },

            stampStatus: "pending",
            completionStatus: "pending",
            lastActionTimestamp: new Date(),
          })
          .where(eq(dealerOnboardingApplications.id, existing[0].id))
          .returning();

        application = updatedApplications[0];
      }
    }

    // Create new application only if no existing one was found
    if (!application) {
      const insertedApplications = await db
        .insert(dealerOnboardingApplications)
        .values({
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
          reviewStatus,
          submittedAt: onboardingStatus === "submitted" ? new Date() : null,
          ownerName,
          ownerPhone,
          ownerEmail,
          bankName,
          accountNumber,
          beneficiaryName,
          ifscCode,
        
          // SAVE AGREEMENT CONFIG
          providerRawResponse: {
            agreement: agreementConfig,
          },

          agreementStatus: "not_generated",
          stampStatus: "pending",
          completionStatus: "pending",
        })
        .returning();

      application = insertedApplications[0];
    }

    // Replace old documents for this application to avoid duplicates
    await db
      .delete(dealerOnboardingDocuments)
      .where(eq(dealerOnboardingDocuments.applicationId, application.id));

    if (documents.length > 0) {
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
          uploadedBy: dealerUserId,
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