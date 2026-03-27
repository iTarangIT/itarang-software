import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";

type UploadLike = {
  id?: string;
  label?: string;
  uploadedUrl?: string | null;
  storagePath?: string | null;
  bucketName?: string | null;
  fileName?: string | null;
  name?: string | null;
  mimeType?: string | null;
  type?: string | null;
  fileSize?: number | null;
  size?: number | null;
  verificationState?: string | null;
};

type SubmitPayload = {
  dealerId?: string;
  applicationId?: string;
  company?: any;
  compliance?: any;
  ownership?: any;
  finance?: any;
  agreement?: any;
  reviewChecks?: any;
};

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function cleanPhone(value: unknown) {
  return typeof value === "string" ? value.replace(/[^0-9]/g, "") : "";
}

function toNullable(value: unknown) {
  const cleaned = cleanString(value);
  return cleaned || null;
}

function toNullableEmail(value: unknown) {
  const cleaned = cleanEmail(value);
  return cleaned || null;
}

function toNullablePhone(value: unknown) {
  const cleaned = cleanPhone(value);
  return cleaned || null;
}

function isUploadedFile(file: UploadLike | null | undefined) {
  return Boolean(file?.uploadedUrl && file?.storagePath && file?.bucketName);
}

function getFileName(file: UploadLike) {
  return (
    cleanString(file.fileName) ||
    cleanString(file.name) ||
    cleanString(file.label) ||
    "document"
  );
}

function buildDocumentRow(
  applicationId: string,
  documentType: string,
  file: UploadLike | null | undefined
) {
  if (!file || !isUploadedFile(file)) return null;

  return {
    applicationId,
    documentType,
    bucketName: cleanString(file.bucketName),
    storagePath: cleanString(file.storagePath),
    fileName: getFileName(file),
    fileUrl: cleanString(file.uploadedUrl) || null,
    mimeType: cleanString(file.mimeType || file.type) || null,
    fileSize: Number(file.fileSize ?? file.size ?? 0) || null,
    uploadedAt: new Date(),
    docStatus: "uploaded",
    verificationStatus: cleanString(file.verificationState) || "pending",
    extractedData: {},
    apiVerificationResults: {},
    metadata: {
      source: "dealer_onboarding_submit",
      originalLabel: cleanString(file.label),
      fileId: cleanString(file.id),
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function collectDocuments(applicationId: string, payload: SubmitPayload) {
  const docs: any[] = [];

  const company = payload.company || {};
  const compliance = payload.compliance || {};
  const ownership = payload.ownership || {};

  const pushDoc = (
    documentType: string,
    file: UploadLike | null | undefined
  ) => {
    const row = buildDocumentRow(applicationId, documentType, file);
    if (row) docs.push(row);
  };

  pushDoc("gst_certificate", company.gstCertificate);
  pushDoc("company_pan", company.companyPanFile);

  pushDoc("itr_3_years", compliance.itr3Years);
  pushDoc("bank_statement_3_months", compliance.bankStatement3Months);
  pushDoc("undated_cheques", compliance.undatedCheques);
  pushDoc("passport_photo", compliance.passportPhoto);
  pushDoc("udyam_certificate", compliance.udyamCertificate);

  pushDoc("owner_photo", ownership.ownerPhoto);
  pushDoc("partnership_deed", ownership.partnershipDeed);
  pushDoc("mou_document", ownership.mouDocument);
  pushDoc("aoa_document", ownership.aoaDocument);

  if (Array.isArray(ownership.partners)) {
    ownership.partners.forEach((partner: any, index: number) => {
      pushDoc(`partner_photo_${index + 1}`, partner?.photo);
    });
  }

  if (Array.isArray(ownership.directors)) {
    ownership.directors.forEach((director: any, index: number) => {
      pushDoc(`director_photo_${index + 1}`, director?.photo);
    });
  }

  return docs;
}

function resolvePrimaryOwner(payload: SubmitPayload) {
  const ownership = payload.ownership || {};
  const agreement = payload.agreement || {};
  const company = payload.company || {};

  const companyType = cleanString(company.companyType);

  if (companyType === "sole_proprietorship") {
    return {
      ownerName:
        cleanString(ownership.ownerName) ||
        cleanString(agreement.dealerSignerName) ||
        null,
      ownerPhone:
        toNullablePhone(ownership.ownerPhone) ||
        toNullablePhone(agreement.dealerSignerPhone),
      ownerEmail:
        toNullableEmail(ownership.ownerEmail) ||
        toNullableEmail(agreement.dealerSignerEmail),
    };
  }

  if (companyType === "partnership_firm") {
    const firstPartner = Array.isArray(ownership.partners)
      ? ownership.partners[0]
      : null;

    return {
      ownerName:
        cleanString(firstPartner?.name) ||
        cleanString(agreement.dealerSignerName) ||
        null,
      ownerPhone:
        toNullablePhone(firstPartner?.phone) ||
        toNullablePhone(agreement.dealerSignerPhone),
      ownerEmail:
        toNullableEmail(firstPartner?.email) ||
        toNullableEmail(agreement.dealerSignerEmail),
    };
  }

  if (companyType === "private_limited_firm") {
    const firstDirector = Array.isArray(ownership.directors)
      ? ownership.directors[0]
      : null;

    return {
      ownerName:
        cleanString(firstDirector?.name) ||
        cleanString(agreement.dealerSignerName) ||
        null,
      ownerPhone:
        toNullablePhone(firstDirector?.phone) ||
        toNullablePhone(agreement.dealerSignerPhone),
      ownerEmail:
        toNullableEmail(firstDirector?.email) ||
        toNullableEmail(agreement.dealerSignerEmail),
    };
  }

  return {
    ownerName: cleanString(agreement.dealerSignerName) || null,
    ownerPhone: toNullablePhone(agreement.dealerSignerPhone),
    ownerEmail: toNullableEmail(agreement.dealerSignerEmail),
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as SubmitPayload;

    const company = body.company || {};
    const compliance = body.compliance || {};
    const ownership = body.ownership || {};
    const finance = body.finance || {};
    const agreement = body.agreement || {};
    const reviewChecks = body.reviewChecks || {};

    if (!cleanString(company.companyName)) {
      return NextResponse.json(
        { success: false, message: "Company name is required" },
        { status: 400 }
      );
    }

    if (!cleanString(company.companyType)) {
      return NextResponse.json(
        { success: false, message: "Company type is required" },
        { status: 400 }
      );
    }

    if (!reviewChecks.confirmInfo || !reviewChecks.confirmDocs || !reviewChecks.agreeTerms) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Please confirm information, confirm documents, and agree to terms before submitting.",
        },
        { status: 400 }
      );
    }

    const primaryOwner = resolvePrimaryOwner(body);

    if (!primaryOwner.ownerEmail) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Owner / primary dealer signatory email is required before submission.",
        },
        { status: 400 }
      );
    }

    const applicationId =
      cleanString(body.applicationId) || cleanString(body.dealerId);

    const financeEnabled = cleanString(finance.enableFinance) === "yes";

    const applicationPayload = {
      companyName: cleanString(company.companyName),
      companyType: cleanString(company.companyType) || null,
      gstNumber: toNullable(company.gstNumber),
      panNumber: toNullable(company.companyPanNumber),
      businessAddress: {
        addressLine1: cleanString(company.companyAddress),
      },
      registeredAddress: {
        addressLine1: cleanString(company.companyAddress),
      },
      financeEnabled,
      onboardingStatus: "submitted" as const,
      reviewStatus: "pending_sales_head",
      submittedAt: new Date(),
      updatedAt: new Date(),

      ownerName: primaryOwner.ownerName,
      ownerPhone: primaryOwner.ownerPhone,
      ownerEmail: primaryOwner.ownerEmail,

      salesManagerName: toNullable(agreement?.salesManager?.name),
      salesManagerEmail: toNullableEmail(agreement?.salesManager?.email),
      salesManagerMobile: toNullablePhone(agreement?.salesManager?.mobile),

      itarangSignatory1Name: toNullable(agreement?.itarangSignatory1?.name),
      itarangSignatory1Email: toNullableEmail(agreement?.itarangSignatory1?.email),
      itarangSignatory1Mobile: toNullablePhone(agreement?.itarangSignatory1?.mobile),

      itarangSignatory2Name: toNullable(agreement?.itarangSignatory2?.name),
      itarangSignatory2Email: toNullableEmail(agreement?.itarangSignatory2?.email),
      itarangSignatory2Mobile: toNullablePhone(agreement?.itarangSignatory2?.mobile),

      bankName: toNullable(ownership.bankName),
      accountNumber: toNullable(ownership.accountNumber),
      beneficiaryName: toNullable(ownership.beneficiaryName),
      ifscCode: toNullable(ownership.ifsc),

      agreementStatus: financeEnabled
        ? cleanString(agreement.agreementStatus) || "not_generated"
        : "not_generated",
      completionStatus: financeEnabled ? "pending" : "completed",

      correctionRemarks: null,
      rejectionRemarks: null,
      rejectedAt: null,
      rejectionReason: null,
      approvedAt: null,
    };

    let finalApplicationId = applicationId;

    await db.transaction(async (tx) => {
      if (finalApplicationId) {
        const existingRows = await tx
          .select()
          .from(dealerOnboardingApplications)
          .where(eq(dealerOnboardingApplications.id, finalApplicationId))
          .limit(1);

        const existing = existingRows[0];

        if (!existing) {
          throw new Error("Dealer onboarding application not found");
        }

        await tx
          .update(dealerOnboardingApplications)
          .set(applicationPayload)
          .where(eq(dealerOnboardingApplications.id, finalApplicationId));
      } else {
        const inserted = await tx
          .insert(dealerOnboardingApplications)
          .values({
            ...applicationPayload,
            createdAt: new Date(),
          })
          .returning({ id: dealerOnboardingApplications.id });

        finalApplicationId = inserted[0]?.id;
      }

      if (!finalApplicationId) {
        throw new Error("Unable to resolve application id during submit");
      }

      await tx
        .delete(dealerOnboardingDocuments)
        .where(eq(dealerOnboardingDocuments.applicationId, finalApplicationId));

      const documentRows = collectDocuments(finalApplicationId, body);

      if (documentRows.length > 0) {
        await tx.insert(dealerOnboardingDocuments).values(documentRows);
      }
    });

    return NextResponse.json({
      success: true,
      message: "Dealer onboarding submitted successfully",
      data: {
        applicationId: finalApplicationId,
        onboardingStatus: "submitted",
        reviewStatus: "pending_sales_head",
        financeEnabled,
      },
    });
  } catch (error: any) {
    console.error("DEALER ONBOARDING SUBMIT ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Failed to submit dealer onboarding",
      },
      { status: 500 }
    );
  }
}