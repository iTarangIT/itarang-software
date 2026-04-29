import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db/index";
import {
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
} from "@/lib/db/schema";
import { createClient } from "@/lib/supabase/server";

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

type LegacyDocumentPayload = {
  documentType?: string;
  bucketName?: string;
  storagePath?: string;
  fileName?: string;
  fileUrl?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  docStatus?: string | null;
  verificationStatus?: string | null;
};

type SubmitPayload = {
  dealerId?: string;
  applicationId?: string;
  dealerCode?: string;
  documents?: LegacyDocumentPayload[];
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

function isUuid(value: string | null) {
  if (!value) return false;

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
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
  file: UploadLike | null | undefined,
  uploadedBy?: string | null
) {
  if (!file || !isUploadedFile(file)) return null;

  return {
    application_id: applicationId,
    document_type: documentType,
    bucket_name: cleanString(file.bucketName),
    storage_path: cleanString(file.storagePath),
    file_name: getFileName(file),
    file_url: cleanString(file.uploadedUrl) || null,
    mime_type: cleanString(file.mimeType || file.type) || null,
    file_size: Number(file.fileSize ?? file.size ?? 0) || null,
    uploaded_by: uploadedBy || null,
    doc_status: "uploaded",
    verification_status: cleanString(file.verificationState) || "pending",
    metadata: {
      source: "dealer_onboarding_submit",
      originalLabel: cleanString(file.label),
      fileId: cleanString(file.id),
    },
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function buildLegacyDocumentRow(
  applicationId: string,
  document: LegacyDocumentPayload,
  uploadedBy?: string | null
) {
  const documentType = cleanString(document?.documentType);
  const bucketName = cleanString(document?.bucketName);
  const storagePath = cleanString(document?.storagePath);
  const fileName = cleanString(document?.fileName);

  if (!documentType || !bucketName || !storagePath || !fileName) {
    return null;
  }

  return {
    application_id: applicationId,
    document_type: documentType,
    bucket_name: bucketName,
    storage_path: storagePath,
    file_name: fileName,
    file_url: cleanString(document.fileUrl) || null,
    mime_type: cleanString(document.mimeType) || null,
    file_size: Number(document.fileSize ?? 0) || null,
    uploaded_by: uploadedBy || null,
    doc_status: cleanString(document.docStatus) || "uploaded",
    verification_status: cleanString(document.verificationStatus) || "pending",
    metadata: {
      source: "dealer_onboarding_submit_legacy_documents",
    },
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function collectDocuments(
  applicationId: string,
  payload: SubmitPayload,
  uploadedBy?: string | null
) {
  const deduped = new Map<string, any>();
  const company = payload.company || {};
  const compliance = payload.compliance || {};
  const ownership = payload.ownership || {};

  const pushDoc = (
    documentType: string,
    file: UploadLike | null | undefined
  ) => {
    const row = buildDocumentRow(applicationId, documentType, file, uploadedBy);
    if (row) {
      deduped.set(`${row.document_type}::${row.storage_path}`, row);
    }
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

  if (Array.isArray(payload.documents)) {
    payload.documents.forEach((document) => {
      const row = buildLegacyDocumentRow(applicationId, document, uploadedBy);
      if (row) {
        deduped.set(`${row.document_type}::${row.storage_path}`, row);
      }
    });
  }

  return Array.from(deduped.values());
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

function resolveOwnerLandline(payload: SubmitPayload) {
  const ownership = payload.ownership || {};
  const company = payload.company || {};
  const companyType = cleanString(company.companyType);

  if (companyType === "partnership_firm") {
    const firstPartner = Array.isArray(ownership.partners)
      ? ownership.partners[0]
      : null;

    return toNullablePhone(firstPartner?.landline);
  }

  if (companyType === "private_limited_firm") {
    const firstDirector = Array.isArray(ownership.directors)
      ? ownership.directors[0]
      : null;

    return toNullablePhone(firstDirector?.landline);
  }

  return toNullablePhone(ownership.ownerLandline);
}

function buildAddress(value: unknown) {
  if (typeof value === "string") {
    const cleaned = cleanString(value);
    return cleaned ? { address: cleaned } : {};
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

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
    return value as Record<string, unknown>;
  }

  return {};
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const rawBody = (await req.json()) as SubmitPayload & Record<string, any>;

    const company = rawBody.company || {
      companyName: rawBody.companyName,
      companyType: rawBody.companyType,
      gstNumber: rawBody.gstNumber,
      companyPanNumber: rawBody.companyPanNumber || rawBody.panNumber,
      companyAddress:
        rawBody.companyAddress ||
        rawBody.businessAddress?.address ||
        rawBody.registeredAddress?.address,
    };
    const compliance = rawBody.compliance || {};
    const ownership = rawBody.ownership || {
      ownerName: rawBody.ownerName,
      ownerPhone: rawBody.ownerPhone,
      ownerLandline: rawBody.ownerLandline,
      ownerEmail: rawBody.ownerEmail,
      bankName: rawBody.bankName,
      accountNumber: rawBody.accountNumber,
      beneficiaryName: rawBody.beneficiaryName,
      ifsc: rawBody.ifscCode,
    };
    const finance = rawBody.finance || {
      enableFinance: rawBody.financeEnabled ? "yes" : "no",
    };
    const agreement = rawBody.agreement || {};
    const reviewChecks = rawBody.reviewChecks || {};

    const body: SubmitPayload = {
      ...rawBody,
      company,
      compliance,
      ownership,
      finance,
      agreement,
      reviewChecks,
    };

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

    if (
      !reviewChecks.confirmInfo ||
      !reviewChecks.confirmDocs ||
      !reviewChecks.agreeTerms
    ) {
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

    const dealerUserId = user?.id || null;
    const authEmail = user?.email || null;
    const applicationId = isUuid(cleanString(body.applicationId))
      ? cleanString(body.applicationId)
      : null;
    const dealerCode =
      cleanString(body.dealerCode) || cleanString(body.dealerId) || null;
    const financeEnabled =
      cleanString(finance.enableFinance) === "yes" ||
      rawBody.financeEnabled === true;

    let existingApplication:
      | typeof dealerOnboardingApplications.$inferSelect
      | null = null;

    if (applicationId) {
      existingApplication =
        (
          await db
            .select()
            .from(dealerOnboardingApplications)
            .where(eq(dealerOnboardingApplications.id, applicationId))
            .limit(1)
        )[0] ?? null;
    }

    if (!existingApplication && dealerUserId) {
      existingApplication =
        (
          await db
            .select()
            .from(dealerOnboardingApplications)
            .where(eq(dealerOnboardingApplications.dealer_user_id, dealerUserId))
            .orderBy(desc(dealerOnboardingApplications.updated_at))
            .limit(1)
        )[0] ?? null;
    }

    if (!existingApplication && primaryOwner.ownerEmail) {
      existingApplication =
        (
          await db
            .select()
            .from(dealerOnboardingApplications)
            .where(
              eq(dealerOnboardingApplications.owner_email, primaryOwner.ownerEmail)
            )
            .orderBy(desc(dealerOnboardingApplications.updated_at))
            .limit(1)
        )[0] ?? null;
    }

    if (!existingApplication && authEmail) {
      existingApplication =
        (
          await db
            .select()
            .from(dealerOnboardingApplications)
            .where(eq(dealerOnboardingApplications.owner_email, authEmail))
            .orderBy(desc(dealerOnboardingApplications.updated_at))
            .limit(1)
        )[0] ?? null;
    }

    if (!existingApplication && dealerCode) {
      existingApplication =
        (
          await db
            .select()
            .from(dealerOnboardingApplications)
            .where(eq(dealerOnboardingApplications.dealer_code, dealerCode))
            .orderBy(desc(dealerOnboardingApplications.updated_at))
            .limit(1)
        )[0] ?? null;
    }

    if (existingApplication?.onboarding_status === "approved") {
      // Allow creating a brand-new application even if a previous one was approved.
      // Reset so the code path below will INSERT instead of UPDATE.
      existingApplication = null;
    }

    const providerRawResponse = {
      ...parseProviderRawResponse(existingApplication?.provider_raw_response),
      agreement,
      submissionSnapshot: {
        company,
        compliance,
        ownership,
        finance,
        reviewChecks,
      },
      source: "dealer_onboarding_submit",
    };

    const applicationPayload: typeof dealerOnboardingApplications.$inferInsert = {
      dealer_user_id:
        dealerUserId || existingApplication?.dealer_user_id || null,
      dealer_code: dealerCode || existingApplication?.dealer_code || null,
      company_name: cleanString(company.companyName),
      company_type: cleanString(company.companyType) || null,
      gst_number: toNullable(company.gstNumber),
      pan_number: toNullable(company.companyPanNumber),
      business_address: JSON.stringify(buildAddress(
        company.companyAddress || rawBody.businessAddress
      )),
      registered_address: JSON.stringify(buildAddress(
        rawBody.registeredAddress || company.companyAddress
      )),
      finance_enabled: financeEnabled,
      onboarding_status: "submitted",
      review_status: "pending_admin_review",
      submitted_at: new Date(),
      updated_at: new Date(),

      owner_name: primaryOwner.ownerName,
      owner_phone: primaryOwner.ownerPhone,
      owner_landline: resolveOwnerLandline(body),
      owner_email: primaryOwner.ownerEmail,

      sales_manager_name: toNullable(agreement?.salesManager?.name),
      sales_manager_email: toNullableEmail(agreement?.salesManager?.email),
      sales_manager_mobile: toNullablePhone(agreement?.salesManager?.mobile),

      itarang_signatory_1_name: toNullable(agreement?.itarangSignatory1?.name),
      itarang_signatory_1_email: toNullableEmail(
        agreement?.itarangSignatory1?.email
      ),
      itarang_signatory_1_mobile: toNullablePhone(
        agreement?.itarangSignatory1?.mobile
      ),

      itarang_signatory_2_name: toNullable(agreement?.itarangSignatory2?.name),
      itarang_signatory_2_email: toNullableEmail(
        agreement?.itarangSignatory2?.email
      ),
      itarang_signatory_2_mobile: toNullablePhone(
        agreement?.itarangSignatory2?.mobile
      ),

      bank_name: toNullable(ownership.bankName),
      account_number: toNullable(ownership.accountNumber),
      beneficiary_name: toNullable(ownership.beneficiaryName),
      ifsc_code: toNullable(ownership.ifsc),

      provider_signing_url: toNullable(agreement.providerSigningUrl),
      provider_document_id: toNullable(agreement.providerDocumentId),
      request_id: toNullable(agreement.requestId),
      provider_raw_response: providerRawResponse,
      agreement_status: financeEnabled
        ? cleanString(agreement.agreementStatus) || "not_generated"
        : "not_generated",
      stamp_status: cleanString(agreement.stampStatus) || "pending",
      completion_status: financeEnabled
        ? cleanString(agreement.completionStatus) || "pending"
        : "completed",
      correction_remarks: null,
      rejection_remarks: null,
      rejected_at: null,
      rejection_reason: null,
      approved_at: null,
      last_action_timestamp: new Date(),
    };

    let finalApplicationId = existingApplication?.id || applicationId || null;

    await db.transaction(async (tx) => {
      if (finalApplicationId) {
        await tx
          .update(dealerOnboardingApplications)
          .set(applicationPayload)
          .where(eq(dealerOnboardingApplications.id, finalApplicationId));
      } else {
        const inserted = await tx
          .insert(dealerOnboardingApplications)
          .values({
            ...applicationPayload,
            created_at: new Date(),
          })
          .returning({ id: dealerOnboardingApplications.id });

        finalApplicationId = inserted[0]?.id ?? null;
      }

      if (!finalApplicationId) {
        throw new Error("Unable to resolve application id during submit");
      }

      await tx
        .delete(dealerOnboardingDocuments)
        .where(eq(dealerOnboardingDocuments.application_id, finalApplicationId));

      const documentRows = collectDocuments(
        finalApplicationId,
        body,
        dealerUserId
      );

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
        reviewStatus: "pending_admin_review",
        financeEnabled,
      },
    });
  } catch (error: any) {
    console.error("DEALER ONBOARDING SUBMIT ERROR:", error);
    console.error("CAUSE:", error?.cause);

    const causeMessage =
      error?.cause instanceof Error ? error.cause.message : undefined;

    return NextResponse.json(
      {
        success: false,
        message:
          causeMessage ||
          error?.message ||
          "Failed to submit dealer onboarding",
      },
      { status: 500 }
    );
  }
}

// hello

// hello
