import { linkOnboardingToLead } from "@/lib/onboarding/linkToLead";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";

import { db } from "@/lib/db/index";
import {
  auditLogs,
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
  users,
} from "@/lib/db/schema";
import { createClient } from "@/lib/supabase/server";
import { readStoredDocument } from "@/lib/storage/readStoredDocument";
import { recordLeadCapture } from "@/lib/leads/lead-registry";
import { readDocument } from "@/lib/whatsapp/extraction";
import { buildGstAddresses } from "@/lib/onboarding/gst-addresses";
import { notifyOnboardingBankChanged, notifyOnboardingSubmitted } from "@/lib/notifications/events";
import {
  bankChanges,
  callerFor,
  decideSubmit,
  maskAccountNumber,
  planDocuments,
  verifyResumeToken,
} from "@/lib/onboarding/submitAccess";
import { markDocsSubmitted } from "@/lib/onboarding/leadMilestones";
import { checkCustomerGstin, GSTIN_CHECK_MESSAGE } from "@/lib/leads/gstin";
import { resolveSalesperson, salespersonMobile } from "@/lib/onboarding/salesperson";

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

// Best-effort GST OCR for the web path: fetch the uploaded GST certificate and
// run the SAME Gemini extractor the WhatsApp flow uses, so the admin sees the
// principal + every Additional Place of Business (and can tag billing/dispatch).
// Never throws — on any failure the submission proceeds without gstAddresses and
// the admin can add/edit addresses manually on the verification page.
async function extractGstAddressesBestEffort(
  gstCert: UploadLike | null | undefined,
): Promise<ReturnType<typeof buildGstAddresses> | null> {
  const url = cleanString(gstCert?.uploadedUrl);
  if (!url) return null;
  try {
    // Direct storage read — uploadedUrl is a relative /api/files/... proxy
    // path on the S3 backend, which a server-side fetch() can't parse.
    const stored = await readStoredDocument(url);
    const mime =
      (stored.contentType !== "application/octet-stream" && stored.contentType) ||
      cleanString(gstCert?.mimeType || gstCert?.type) ||
      "application/pdf";
    const extracted = await readDocument(stored.buffer, mime, "gst");
    if (!extracted.ok) return null;
    return buildGstAddresses(extracted.fields);
  } catch (err) {
    console.error("[onboarding/submit] GST address extraction failed:", err);
    return null;
  }
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

    // ID 129: this form needs no login, so WHO is calling decides what it may
    // touch — iTarang staff, a signed-in dealer, or nobody (submitAccess.ts).
    let callerRole: string | null = null;
    if (user) {
      callerRole =
        (
          await db
            .select({ role: users.role })
            .from(users)
            .where(eq(users.id, user.id))
            .limit(1)
        )[0]?.role ?? null;
    }
    const caller = callerFor(user ? { id: user.id, role: callerRole } : null);
    const isStaff = caller.kind === "staff";
    // A flag the browser sends; only a staff session makes it true.
    const internalSubmission = isStaff && rawBody.internalSubmission === true;

    const company = rawBody.company || {
      companyName: rawBody.companyName,
      companyType: rawBody.companyType,
      dealerType: rawBody.dealerType,
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

    // ID 62: shape, check digit, and never iTarang's own registration.
    if (cleanString(company.gstNumber)) {
      const gst = checkCustomerGstin(company.gstNumber);
      if (gst !== "ok") {
        return NextResponse.json(
          { success: false, message: GSTIN_CHECK_MESSAGE[gst] },
          { status: 400 }
        );
      }
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

    // Only the fields actually used below — selecting the whole row (Drizzle's
    // default `.select()`) makes this lookup crash if ANY schema column is
    // missing from the live DB (e.g. an unapplied additive migration like
    // E-127's originating_dealer_lead_id). Narrow it so Submit is resilient to
    // such drift; the INSERT/UPDATE payload below never touches those columns.
    const lookupColumns = {
      id: dealerOnboardingApplications.id,
      dealer_user_id: dealerOnboardingApplications.dealer_user_id,
      dealer_code: dealerOnboardingApplications.dealer_code,
      provider_raw_response: dealerOnboardingApplications.provider_raw_response,
      onboarding_status: dealerOnboardingApplications.onboarding_status,
      salesperson_user_id: dealerOnboardingApplications.salesperson_user_id,
      is_locked: dealerOnboardingApplications.is_locked,
      bank_name: dealerOnboardingApplications.bank_name,
      account_number: dealerOnboardingApplications.account_number,
      beneficiary_name: dealerOnboardingApplications.beneficiary_name,
      ifsc_code: dealerOnboardingApplications.ifsc_code,
      provider_signing_url: dealerOnboardingApplications.provider_signing_url,
      provider_document_id: dealerOnboardingApplications.provider_document_id,
      request_id: dealerOnboardingApplications.request_id,
      agreement_status: dealerOnboardingApplications.agreement_status,
      stamp_status: dealerOnboardingApplications.stamp_status,
      completion_status: dealerOnboardingApplications.completion_status,
    } as const;

    const firstRow = async (where: ReturnType<typeof eq> | ReturnType<typeof and>) =>
      (
        await db
          .select(lookupColumns)
          .from(dealerOnboardingApplications)
          .where(where)
          .orderBy(desc(dealerOnboardingApplications.updated_at))
          .limit(1)
      )[0] ?? null;

    // ID 129 — three DIFFERENT ways an application can be related to this
    // request, kept apart because they do not carry the same weight:
    //   byId        the application id the request names
    //   byUser      a signed-in dealer's own application
    //   byIdentity  an OPEN application with the same owner e-mail or dealer
    //               code as the one typed into the form
    // The old code tried them in turn and overwrote the first hit. A typed
    // e-mail or dealer code is not proof of anything: decideSubmit() lets
    // them point at an application only for a caller who proves it is theirs.
    const byId = applicationId
      ? await firstRow(eq(dealerOnboardingApplications.id, applicationId))
      : null;
    const byUser =
      caller.kind === "dealer"
        ? await firstRow(eq(dealerOnboardingApplications.dealer_user_id, caller.userId))
        : null;
    const identityMatches = [
      primaryOwner.ownerEmail
        ? sql`lower(btrim(${dealerOnboardingApplications.owner_email})) = ${primaryOwner.ownerEmail.trim().toLowerCase()}`
        : null,
      authEmail
        ? sql`lower(btrim(${dealerOnboardingApplications.owner_email})) = ${authEmail.trim().toLowerCase()}`
        : null,
      dealerCode ? eq(dealerOnboardingApplications.dealer_code, dealerCode) : null,
    ].filter((c): c is NonNullable<typeof c> => c !== null);
    const byIdentity = identityMatches.length
      ? await firstRow(
          and(
            or(...identityMatches),
            // An earlier, approved application never blocks a new one.
            sql`COALESCE(${dealerOnboardingApplications.onboarding_status}, 'draft') <> 'approved'`,
          ),
        )
      : null;

    const decision = decideSubmit({
      caller,
      byId,
      byUser,
      byIdentity,
      resumeApplicationId: verifyResumeToken(cleanString(rawBody.resumeToken)),
    });
    if (decision.action === "refuse") {
      return NextResponse.json(
        { success: false, code: decision.code, message: decision.message },
        { status: decision.status },
      );
    }
    const existingApplication =
      decision.action === "update"
        ? [byId, byUser, byIdentity].find((a) => a?.id === decision.applicationId) ?? null
        : null;

    // Web path GST OCR — reuse the WhatsApp Gemini extractor. Best-effort: a
    // failure leaves gstAddresses unset and the admin adds them manually.
    const gstAddresses = await extractGstAddressesBestEffort(
      company?.gstCertificate,
    );

    // ID 66 (E-321): the salesperson is mandatory and is a CRM user, picked
    // from a dropdown. Their name / email / mobile are read from the user row.
    const salesperson = await resolveSalesperson(
      cleanString(agreement?.salesManager?.userId) ||
        existingApplication?.salesperson_user_id
    );
    if (!salesperson) {
      return NextResponse.json(
        { success: false, message: "Select the salesperson handling this dealer." },
        { status: 400 }
      );
    }
    agreement.salesManager = {
      ...(agreement.salesManager || {}),
      userId: salesperson.id,
      name: salesperson.name,
      email: salesperson.email,
      mobile: salespersonMobile(salesperson.phone) ?? "",
    };

    const providerRawResponse = {
      ...parseProviderRawResponse(existingApplication?.provider_raw_response),
      agreement,
      submissionSnapshot: {
        company,
        compliance,
        ownership,
        finance,
        reviewChecks,
        ...(gstAddresses ? { gstAddresses } : {}),
      },
      source: "dealer_onboarding_submit",
    };

    const applicationPayload: typeof dealerOnboardingApplications.$inferInsert = {
      // Internal staff (sales/admin) completing a converted lead's onboarding
      // must NOT be stamped as the dealer — keep dealer_user_id NULL until the
      // real dealer login is provisioned at approval (BRD §0.13).
      // ID 129: `internalSubmission` is honoured only for a staff session, and
      // an application that already has its dealer is never re-stamped to
      // whoever happens to be submitting.
      dealer_user_id:
        internalSubmission || isStaff
          ? existingApplication?.dealer_user_id ?? null
          : existingApplication?.dealer_user_id || dealerUserId || null,
      dealer_code: dealerCode || existingApplication?.dealer_code || null,
      company_name: cleanString(company.companyName),
      company_type: cleanString(company.companyType) || null,
      dealer_type: cleanString(company.dealerType) || null,
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
      // E-175 — owner Aadhaar (typed in the web wizard), normalized to 12 digits.
      owner_aadhaar_no: (() => {
        const d = (cleanString(ownership.ownerAadhaarNumber) || "").replace(/\D/g, "");
        return d.length === 12 ? d : null;
      })(),

      sales_manager_name: toNullable(agreement?.salesManager?.name),
      sales_manager_email: toNullableEmail(agreement?.salesManager?.email),
      sales_manager_mobile: toNullablePhone(agreement?.salesManager?.mobile),
      salesperson_user_id: salesperson.id,

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

      // ID 129: where the agreement stands is set by the agreement flow, not
      // by whatever the browser posts. Staff may still pass these (the
      // admin-initiated path); for everyone else an existing application keeps
      // its own values and a new one starts clean.
      provider_signing_url: isStaff
        ? toNullable(agreement.providerSigningUrl)
        : existingApplication?.provider_signing_url ?? null,
      provider_document_id: isStaff
        ? toNullable(agreement.providerDocumentId)
        : existingApplication?.provider_document_id ?? null,
      request_id: isStaff
        ? toNullable(agreement.requestId)
        : existingApplication?.request_id ?? null,
      provider_raw_response: providerRawResponse,
      agreement_status: !financeEnabled
        ? "not_generated"
        : isStaff
          ? cleanString(agreement.agreementStatus) || "not_generated"
          : existingApplication?.agreement_status || "not_generated",
      stamp_status: isStaff
        ? cleanString(agreement.stampStatus) || "pending"
        : existingApplication?.stamp_status || "pending",
      completion_status: !financeEnabled
        ? "completed"
        : isStaff
          ? cleanString(agreement.completionStatus) || "pending"
          : existingApplication?.completion_status || "pending",
      correction_remarks: null,
      rejection_remarks: null,
      rejected_at: null,
      rejection_reason: null,
      approved_at: null,
      last_action_timestamp: new Date(),
    };

    // ID 129: ONLY the application decideSubmit() chose. This used to fall back
    // to the id in the request, so naming an approved application's id updated
    // it even though the lookup above had set it aside.
    let finalApplicationId: string | null = existingApplication?.id ?? null;

    const bankDiff = existingApplication
      ? bankChanges(existingApplication, {
          bank_name: applicationPayload.bank_name,
          account_number: applicationPayload.account_number,
          beneficiary_name: applicationPayload.beneficiary_name,
          ifsc_code: applicationPayload.ifsc_code,
        })
      : [];
    // Only a CHANGE to details that were already there is worth an alarm.
    const bankWasSet =
      !!existingApplication &&
      !!(existingApplication.account_number || existingApplication.ifsc_code);

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

      // ID 129: this used to delete every document row and insert the new set.
      // Now a file that is unchanged is left alone (its verification state
      // with it), and one the submission replaces is written to the audit log
      // before its row goes — the file itself stays in storage.
      const documentRows = collectDocuments(
        finalApplicationId,
        body,
        dealerUserId
      );
      const storedDocuments = await tx
        .select()
        .from(dealerOnboardingDocuments)
        .where(eq(dealerOnboardingDocuments.application_id, finalApplicationId));
      const docPlan = planDocuments(storedDocuments, documentRows);

      if (docPlan.replaced.length > 0) {
        await tx.insert(auditLogs).values({
          id: randomUUID(),
          entity_type: "dealer_onboarding_application",
          entity_id: finalApplicationId,
          action: "onboarding_documents_replaced",
          performed_by: dealerUserId,
          old_data: { documents: docPlan.replaced },
          new_data: {
            caller: caller.kind,
            replaced_by: docPlan.add.map((d) => ({
              document_type: d.document_type,
              storage_path: d.storage_path,
            })),
          },
          timestamp: new Date(),
        });
        await tx
          .delete(dealerOnboardingDocuments)
          .where(
            and(
              eq(dealerOnboardingDocuments.application_id, finalApplicationId),
              inArray(
                dealerOnboardingDocuments.id,
                docPlan.replaced.map((d) => d.id),
              ),
            ),
          );
      }
      if (docPlan.add.length > 0) {
        await tx.insert(dealerOnboardingDocuments).values(docPlan.add);
      }

      // ID 129: every change to bank details is recorded — who, when, old and
      // new — in full here; the alert below carries only the last four digits.
      if (bankDiff.length > 0 && existingApplication) {
        await tx.insert(auditLogs).values({
          id: randomUUID(),
          entity_type: "dealer_onboarding_application",
          entity_id: finalApplicationId,
          action: "onboarding_bank_details_changed",
          performed_by: dealerUserId,
          old_data: {
            bank_name: existingApplication.bank_name,
            account_number: existingApplication.account_number,
            beneficiary_name: existingApplication.beneficiary_name,
            ifsc_code: existingApplication.ifsc_code,
          },
          new_data: {
            bank_name: applicationPayload.bank_name ?? null,
            account_number: applicationPayload.account_number ?? null,
            beneficiary_name: applicationPayload.beneficiary_name ?? null,
            ifsc_code: applicationPayload.ifsc_code ?? null,
            caller: caller.kind,
          },
          changes: { fields: bankDiff.map((c) => c.field) },
          timestamp: new Date(),
        });
      }
    });

    if (bankDiff.length > 0 && bankWasSet && finalApplicationId) {
      // Best-effort — never break the submission.
      await notifyOnboardingBankChanged({
        applicationId: finalApplicationId,
        businessName:
          cleanString(company.companyName) || primaryOwner.ownerName || "A dealer",
        fields: bankDiff.map((c) => c.field),
        accountFrom: maskAccountNumber(existingApplication?.account_number),
        accountTo: maskAccountNumber(applicationPayload.account_number),
        changedBy: caller.kind,
      }).catch((e) => console.error("[onboarding] bank-change alert failed", e));
    }

    // ID 84.2: stamp the lead's "docs submitted" milestone (first submission
    // only). Best-effort — never throws.
    // ID 67 / P1-4: link this onboarding to its lead by phone. Never throws.
    await linkOnboardingToLead(finalApplicationId!);
    await markDocsSubmitted(finalApplicationId);

    // Notify the Dealer Validation team that an application has arrived.
    // Widened from sales_head alone to the full admin audience: sales_head
    // staffs /admin/dealer-verification per middleware.ts, but admin/CEO/
    // business_head all work that queue too and were being left out.
    // Best-effort — never break the submission.
    await notifyOnboardingSubmitted({
      dealerId: finalApplicationId,
      applicationId: finalApplicationId,
      businessName:
        cleanString(company.companyName) || primaryOwner.ownerName || "A dealer",
      channel: "portal",
    });

    // E-179 central registry. No-op if the save-route autosave already
    // registered this application (unique on source_table + source_id).
    await recordLeadCapture({
      leadType: "dealer",
      name: primaryOwner.ownerName || cleanString(company.companyName),
      phone: primaryOwner.ownerPhone,
      sourceChannel: "web",
      sourceTable: "dealer_onboarding_applications",
      sourceId: finalApplicationId!,
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
