import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { createServerClient } from "@supabase/ssr";

import { db } from "@/lib/db/index";
import {
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
} from "@/lib/db/schema";

type NullableString = string | null;
type SafeRecord = Record<string, unknown>;

function cleanString(value: unknown): NullableString {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanEmail(value: unknown): NullableString {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanPhone(value: unknown): NullableString {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

function cleanBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "yes";
  }
  return false;
}

function cleanObject(value: unknown): SafeRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as SafeRecord)
    : {};
}

function mergeCookies(from: NextResponse, to: NextResponse) {
  from.cookies.getAll().forEach((cookie) => to.cookies.set(cookie));
}

export async function POST(req: NextRequest) {
  const cookieCollector = new NextResponse();

  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) {
            return req.cookies.get(name)?.value;
          },
          set(name: string, value: string, options: Record<string, any>) {
            cookieCollector.cookies.set({ name, value, ...options });
          },
          remove(name: string, options: Record<string, any>) {
            cookieCollector.cookies.set({
              name,
              value: "",
              ...options,
              maxAge: 0,
            });
          },
        },
      }
    );

    const {
      data: { user },
    } = await supabase.auth.getUser();

    // Middleware treats /api/* as public (src/middleware.ts), so enforce auth
    // here. Without this, an unauthenticated caller could hit the ownerEmail /
    // dealerCode fallback lookups below and claim/update another dealer's draft.
    if (!user) {
      const res = NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
      mergeCookies(cookieCollector, res);
      return res;
    }

    const body = await req.json();

    const dealerUserId: string = user.id;
    const dealerCode =
      cleanString(body.dealerCode) ||
      cleanString(body.dealer_id) ||
      cleanString(body.dealerId) ||
      null;

    const companyName = cleanString(body.companyName);
    const companyType = cleanString(body.companyType);
    const gstNumber = cleanString(body.gstNumber);
    const panNumber = cleanString(body.panNumber);

    const businessAddress = cleanObject(body.businessAddress);
    const registeredAddress = cleanObject(body.registeredAddress);
    const financeEnabled = cleanBoolean(body.financeEnabled);

    // The final onboarding/review status is computed AFTER we look up the
    // existing row, so a draft autosave cannot regress a row that the dealer
    // already submitted (or that the admin moved to correction_requested /
    // rejected). See the computation block after the `existing` query below.
    const isExplicitSubmission = body.onboardingStatus === "submitted";

    const ownerName = cleanString(body.ownerName);
    const ownerPhone = cleanPhone(body.ownerPhone);
    const ownerEmail = cleanEmail(body.ownerEmail);

    // ── Landline (optional) ──────────────────────────────────────────────────
    const ownerLandline = cleanPhone(body.ownerLandline) || null;
    // ────────────────────────────────────────────────────────────────────────

    const bankName = cleanString(body.bankName);
    const accountNumber = cleanString(body.accountNumber);
    const beneficiaryName = cleanString(body.beneficiaryName);
    const ifscCode = cleanString(body.ifscCode);

    // Distinguish "client explicitly sent a (possibly empty) documents list"
    // from "client omitted documents entirely" — the former is a replace; the
    // latter must NOT touch existing document rows.
    const documentsProvided = Array.isArray(body.documents);
    const documents: SafeRecord[] = documentsProvided
      ? (body.documents as SafeRecord[])
      : [];

    const agreementConfig = cleanObject(body.agreement);

    const salesManager =
      cleanObject(agreementConfig["salesManager"]) ||
      cleanObject(body["salesManager"]);

    const itarangSignatory1 =
      cleanObject(agreementConfig["itarangSignatory1"]) ||
      cleanObject(body["itarangSignatory1"]);

    const itarangSignatory2 =
      cleanObject(agreementConfig["itarangSignatory2"]) ||
      cleanObject(body["itarangSignatory2"]);

    const salesManagerName = cleanString(
      salesManager["name"] ?? salesManager["salesManagerName"]
    );

    const salesManagerEmail = cleanEmail(
      salesManager["email"] ??
        salesManager["emailId"] ??
        salesManager["salesManagerEmail"]
    );

    const salesManagerMobile = cleanPhone(
      salesManager["mobile"] ??
        salesManager["phone"] ??
        salesManager["contactNumber"] ??
        salesManager["salesManagerMobile"]
    );

    const itarangSignatory1Name = cleanString(itarangSignatory1["name"]);
    const itarangSignatory1Email = cleanEmail(itarangSignatory1["email"]);
    const itarangSignatory1Mobile = cleanPhone(itarangSignatory1["mobile"]);

    const itarangSignatory2Name = cleanString(itarangSignatory2["name"]);
    const itarangSignatory2Email = cleanEmail(itarangSignatory2["email"]);
    const itarangSignatory2Mobile = cleanPhone(itarangSignatory2["mobile"]);

    console.log("SAVE ROUTE AUTH USER ID:", dealerUserId);
    console.log("SAVE ROUTE COMPANY NAME:", companyName);
    console.log("SAVE ROUTE EXPLICIT SUBMISSION:", isExplicitSubmission);

    if (!companyName) {
      const res = NextResponse.json(
        { success: false, message: "Company name is required" },
        { status: 400 }
      );
      mergeCookies(cookieCollector, res);
      return res;
    }

    if (isExplicitSubmission) {
      if (!ownerName) {
        const res = NextResponse.json(
          { success: false, message: "Primary contact name is required before submission" },
          { status: 400 }
        );
        mergeCookies(cookieCollector, res);
        return res;
      }

      if (!ownerPhone) {
        const res = NextResponse.json(
          { success: false, message: "Primary contact phone is required before submission" },
          { status: 400 }
        );
        mergeCookies(cookieCollector, res);
        return res;
      }

      if (!ownerEmail) {
        const res = NextResponse.json(
          { success: false, message: "Primary contact email is required before submission" },
          { status: 400 }
        );
        mergeCookies(cookieCollector, res);
        return res;
      }
    }

    let application: typeof dealerOnboardingApplications.$inferSelect | null = null;

    // Only resolve rows owned by the authenticated dealer. Prior version
    // matched on body.ownerEmail / body.dealerCode too — attacker-controlled
    // keys with no ownership constraint — which could let one dealer take
    // over another dealer's in-progress draft.
    const existing = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.dealer_user_id, dealerUserId))
      .limit(1);

    if (existing.length > 0) application = existing[0];

    if (application && application.onboarding_status === "approved") {
      // Don't modify approved applications via auto-save.
      // Return success silently so the frontend doesn't show an error.
      const res = NextResponse.json({
        success: true,
        data: { applicationId: application.id, onboardingStatus: "approved" },
        message: "Application already approved.",
      });
      mergeCookies(cookieCollector, res);
      return res;
    }

    // A draft autosave must NEVER regress a row that the dealer already
    // submitted, or that the admin moved to correction_requested / rejected —
    // otherwise the admin queue shows the row as "pending admin review" while
    // the approve endpoint rejects it for `onboarding_status !== "submitted"`.
    // Only an explicit submission (body.onboardingStatus === "submitted")
    // promotes a draft to submitted; anything else preserves the prior state.
    const previousOnboardingStatus = application?.onboarding_status ?? null;
    const previousReviewStatus = application?.review_status ?? null;

    const onboardingStatus = isExplicitSubmission
      ? "submitted"
      : previousOnboardingStatus && previousOnboardingStatus !== "draft"
        ? previousOnboardingStatus
        : "draft";

    const reviewStatus =
      onboardingStatus === "submitted"
        ? "pending_admin_review"
        : previousReviewStatus && previousReviewStatus !== "draft"
          ? previousReviewStatus
          : "draft";

    // Transitioning to submitted (or an explicit agreement regen request)
    // should reset the Digio workflow. On a plain draft autosave we must
    // preserve the live provider document — otherwise every keystroke would
    // blow away the signing URL, requestId, and stamp/completion status
    // of an in-flight agreement.
    const isSubmissionTransition = onboardingStatus === "submitted";
    const shouldResetProviderWorkflow =
      isSubmissionTransition ||
      cleanString(agreementConfig["regenerate"]) === "true";

    // Shared fields including ownerLandline
    const sharedFields = {
      dealer_code: dealerCode,
      company_name: companyName,
      company_type: companyType,
      gst_number: gstNumber,
      pan_number: panNumber,
      business_address: businessAddress ? JSON.stringify(businessAddress) : null,
      registered_address: registeredAddress ? JSON.stringify(registeredAddress) : null,
      finance_enabled: financeEnabled,
      onboarding_status: onboardingStatus,
      review_status: reviewStatus,
      owner_name: ownerName,
      owner_phone: ownerPhone,
      owner_email: ownerEmail,
      owner_landline: ownerLandline,   // ← new field
      bank_name: bankName,
      account_number: accountNumber,
      beneficiary_name: beneficiaryName,
      ifsc_code: ifscCode,
      sales_manager_name: salesManagerName,
      sales_manager_email: salesManagerEmail,
      sales_manager_mobile: salesManagerMobile,
      itarang_signatory_1_name: itarangSignatory1Name,
      itarang_signatory_1_email: itarangSignatory1Email,
      itarang_signatory_1_mobile: itarangSignatory1Mobile,
      itarang_signatory_2_name: itarangSignatory2Name,
      itarang_signatory_2_email: itarangSignatory2Email,
      itarang_signatory_2_mobile: itarangSignatory2Mobile,
      provider_raw_response: { agreement: agreementConfig },
      last_action_timestamp: new Date(),
    };

    if (application) {
      const updatePayload: Record<string, unknown> = {
        ...sharedFields,
        dealer_user_id: dealerUserId || application.dealer_user_id,
        submitted_at: isSubmissionTransition ? new Date() : application.submitted_at,
        updated_at: new Date(),
      };

      if (shouldResetProviderWorkflow) {
        updatePayload.agreementStatus = "not_generated";
        updatePayload.providerSigningUrl = null;
        updatePayload.providerDocumentId = null;
        updatePayload.requestId = null;
        updatePayload.stampStatus = "pending";
        updatePayload.completionStatus = "pending";
      } else {
        // Autosave on a draft: keep whatever Digio state the row already has.
        updatePayload.agreementStatus =
          (typeof agreementConfig["agreementStatus"] === "string" &&
            agreementConfig["agreementStatus"]) ||
          application.agreement_status ||
          "not_generated";
      }

      const updatedApplications = await db
        .update(dealerOnboardingApplications)
        .set(updatePayload)
        .where(eq(dealerOnboardingApplications.id, application.id))
        .returning();

      application = updatedApplications[0] ?? null;
    } else {
      const insertedApplications = await db
        .insert(dealerOnboardingApplications)
        .values({
          ...sharedFields,
          dealer_user_id: dealerUserId,
          submitted_at: onboardingStatus === "submitted" ? new Date() : null,
          agreement_status: "not_generated",
          // New rows start in the "pending" workflow states — these were
          // previously in sharedFields but were moved out so autosave on
          // existing rows doesn't overwrite live Digio state.
          stamp_status: "pending",
          completion_status: "pending",
        })
        .returning();

      application = insertedApplications[0] ?? null;
    }

    if (!application) {
      const res = NextResponse.json(
        { success: false, message: "Failed to create or update onboarding application" },
        { status: 500 }
      );
      mergeCookies(cookieCollector, res);
      return res;
    }

    // Only replace documents when the client explicitly sent a documents
    // array. Omitting the field must leave existing rows untouched —
    // otherwise any partial save (e.g. company-name edit) would wipe every
    // uploaded KYC file for the applicationId.
    if (documentsProvided) {
      await db
        .delete(dealerOnboardingDocuments)
        .where(eq(dealerOnboardingDocuments.application_id, application.id));
    }

    if (documentsProvided && documents.length > 0) {
      const validDocuments = documents
        .filter((doc) => {
          return (
            typeof doc["documentType"] === "string" &&
            typeof doc["bucketName"] === "string" &&
            typeof doc["storagePath"] === "string" &&
            typeof doc["fileName"] === "string"
          );
        })
        .map((doc) => ({
          application_id: application!.id,
          document_type: String(doc["documentType"]),
          bucket_name: String(doc["bucketName"]),
          storage_path: String(doc["storagePath"]),
          file_name: String(doc["fileName"]),
          file_url: typeof doc["fileUrl"] === "string" ? doc["fileUrl"] : null,
          mime_type: typeof doc["mimeType"] === "string" ? doc["mimeType"] : null,
          file_size: typeof doc["fileSize"] === "number" ? doc["fileSize"] : null,
          uploaded_by: dealerUserId,
          doc_status: typeof doc["docStatus"] === "string" ? doc["docStatus"] : "uploaded",
          verification_status:
            typeof doc["verificationStatus"] === "string"
              ? doc["verificationStatus"]
              : "pending",
          metadata:
            doc["metadata"] &&
            typeof doc["metadata"] === "object" &&
            !Array.isArray(doc["metadata"])
              ? (doc["metadata"] as Record<string, unknown>)
              : {},
        }));

      if (validDocuments.length > 0) {
        await db.insert(dealerOnboardingDocuments).values(validDocuments);
      }
    }

    const res = NextResponse.json({ success: true, application });
    mergeCookies(cookieCollector, res);
    return res;
  } catch (error: any) {
    console.error("SAVE ONBOARDING ERROR FULL:", error);
    console.error("SAVE ONBOARDING ERROR MESSAGE:", error?.message);
    console.error("SAVE ONBOARDING ERROR CAUSE:", error?.cause);

    const res = NextResponse.json(
      {
        success: false,
        message:
          error?.cause?.message ||
          error?.message ||
          "Failed to save onboarding application",
      },
      { status: 500 }
    );
    mergeCookies(cookieCollector, res);
    return res;
  }
}