import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import {
  dealerCorrectionItems,
  dealerCorrectionRounds,
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
} from "@/lib/db/schema";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import {
  documentLabel,
  fieldLabel,
} from "@/lib/onboarding/correction-catalog";

const PatchBodySchema = z.object({
  companyName: z.string().optional(),
  companyAddress: z.string().optional(),
  gstNumber: z.string().optional(),
  panNumber: z.string().optional(),
  cinNumber: z.string().optional(),
  companyType: z.string().optional(),
  ownerName: z.string().optional(),
  ownerPhone: z.string().optional(),
  ownerEmail: z.string().optional(),
  bankName: z.string().optional(),
  accountNumber: z.string().optional(),
  beneficiaryName: z.string().optional(),
  ifscCode: z.string().optional(),
  agreementLanguage: z.string().optional(),

  // Owner residential address (sole proprietorship) — persisted in
  // providerRawResponse.submissionSnapshot.ownership
  ownerAddressLine1: z.string().optional(),
  ownerCity: z.string().optional(),
  ownerDistrict: z.string().optional(),
  ownerState: z.string().optional(),
  ownerPinCode: z.string().optional(),

  // Bank extras — also persisted in submissionSnapshot.ownership
  bankBranch: z.string().optional(),
  accountType: z.string().optional(),

  // Sales manager — stored in columns AND in providerRawResponse.agreement.salesManager
  salesManagerName: z.string().optional(),
  salesManagerEmail: z.string().optional(),
  salesManagerMobile: z.string().optional(),
});

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

function parseProviderRawResponse(value: unknown) {
  if (!value) return {};
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return {}; }
  }
  if (typeof value === "object") return value as Record<string, any>;
  return {};
}

function extractAddress(value: unknown) {
  if (!value) return "";
  // business_address is a TEXT column that may hold a raw address or a
  // JSON-encoded object like '{"address":"Pune"}'. Parse first so the UI
  // never sees the wrapper braces/quotes.
  let normalized: unknown = value;
  if (typeof normalized === "string") {
    const trimmed = normalized.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try { normalized = JSON.parse(trimmed); } catch { return trimmed; }
    } else {
      return trimmed;
    }
  }
  if (typeof normalized === "object" && normalized !== null) {
    const obj = normalized as Record<string, any>;
    return (
      obj.address ||
      obj.fullAddress ||
      [obj.line1, obj.line2, obj.city, obj.state, obj.pincode].filter(Boolean).join(", ")
    );
  }
  return "";
}

// ─── GET ────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest, context: RouteContext) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;
  try {
    const { dealerId } = await context.params;

    const application = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, dealerId));

    const row = application[0];

    if (!row) {
      return NextResponse.json(
        { success: false, message: "Dealer onboarding application not found" },
        { status: 404 }
      );
    }

    // Hide superseded documents (replaced via correction round) and
    // pending_correction documents (those belong to the in-flight correction
    // card, not the main verification list). Then keep only the most recent
    // upload per document_type so the admin sees a single fresh row per item
    // — no stale duplicates after re-upload.
    const allDocuments = await db
      .select()
      .from(dealerOnboardingDocuments)
      .where(
        and(
          eq(dealerOnboardingDocuments.application_id, row.id),
          ne(dealerOnboardingDocuments.doc_status, "superseded"),
          ne(dealerOnboardingDocuments.doc_status, "pending_correction"),
        ),
      );

    const latestPerType = new Map<string, (typeof allDocuments)[number]>();
    for (const doc of allDocuments) {
      const prior = latestPerType.get(doc.document_type);
      if (
        !prior ||
        new Date(doc.uploaded_at).getTime() >
          new Date(prior.uploaded_at).getTime()
      ) {
        latestPerType.set(doc.document_type, doc);
      }
    }

    const documents = Array.from(latestPerType.values()).map((doc) => ({
      id: doc.id,
      name: doc.file_name || doc.document_type,
      documentType: doc.document_type,
      url: doc.file_url || "",
      docStatus: doc.doc_status,
      verificationStatus: doc.verification_status,
      uploadedAt: doc.uploaded_at,
      rejectionReason: doc.rejection_reason,
    }));

    // Latest correction round (any status). The review page renders the
    // "Correction Response" panel only when status === "submitted"; other
    // states are surfaced as small status pills so the admin can tell whether
    // a round is awaiting the dealer.
    //
    // Wrapped in try/catch so the review page still loads if the correction
    // tables haven't been migrated yet (e.g. local DB without db:push) —
    // correction data is enrichment, not core review data.
    let correctionRound: unknown = null;
    try {
      const [latestRound] = await db
        .select()
        .from(dealerCorrectionRounds)
        .where(eq(dealerCorrectionRounds.application_id, row.id))
        .orderBy(desc(dealerCorrectionRounds.round_number))
        .limit(1);

      if (latestRound) {
        const items = await db
          .select()
          .from(dealerCorrectionItems)
          .where(eq(dealerCorrectionItems.round_id, latestRound.id));

        const linkedDocIds = items
          .flatMap((it) => [it.previous_document_id, it.new_document_id])
          .filter((v): v is string => !!v);

        const linkedDocs =
          linkedDocIds.length > 0
            ? await db
                .select({
                  id: dealerOnboardingDocuments.id,
                  fileName: dealerOnboardingDocuments.file_name,
                  fileUrl: dealerOnboardingDocuments.file_url,
                  uploadedAt: dealerOnboardingDocuments.uploaded_at,
                })
                .from(dealerOnboardingDocuments)
                .where(inArray(dealerOnboardingDocuments.id, linkedDocIds))
            : [];
        const docsById = new Map(linkedDocs.map((d) => [d.id, d]));

        correctionRound = {
          id: latestRound.id,
          roundNumber: latestRound.round_number,
          status: latestRound.status,
          remarks: latestRound.remarks,
          dealerNote: latestRound.dealer_note,
          createdAt: latestRound.created_at,
          dealerSubmittedAt: latestRound.dealer_submitted_at,
          appliedAt: latestRound.applied_at,
          tokenExpiresAt: latestRound.token_expires_at,
          items: items.map((it) => ({
            id: it.id,
            kind: it.kind,
            key: it.key,
            label: it.kind === "field" ? fieldLabel(it.key) : documentLabel(it.key),
            previousValue: it.previous_value,
            newValue: it.new_value,
            previousDocument: it.previous_document_id
              ? docsById.get(it.previous_document_id) ?? null
              : null,
            newDocument: it.new_document_id
              ? docsById.get(it.new_document_id) ?? null
              : null,
          })),
        };
      }
    } catch (correctionError: any) {
      console.warn(
        "Could not load correction round (tables may not be migrated yet):",
        correctionError?.message,
      );
      correctionRound = null;
    }

    const providerData = parseProviderRawResponse(row.provider_raw_response);
    const agreementData = providerData?.agreement || {};
    const ownershipSnapshot =
      (providerData as any)?.submissionSnapshot?.ownership || {};
    const salesManagerSnapshot = agreementData?.salesManager || {};
    const partnersSnapshot = Array.isArray(ownershipSnapshot?.partners)
      ? ownershipSnapshot.partners
      : [];
    const directorsSnapshot = Array.isArray(ownershipSnapshot?.directors)
      ? ownershipSnapshot.directors
      : [];

    return NextResponse.json({
      success: true,
      data: {
        id: row.id,
        dealerId: row.id,

        companyName: row.company_name,
        companyAddress: extractAddress(row.business_address),
        gstNumber: row.gst_number,
        panNumber: row.pan_number,
        // cinNumber: row.cinNumber,
        companyType: row.company_type,

        ownerName: row.owner_name,
        ownerPhone: row.owner_phone,
        ownerEmail: row.owner_email,

        bankName: row.bank_name,
        accountNumber: row.account_number,
        beneficiaryName: row.beneficiary_name,
        ifscCode: row.ifsc_code,

        // Bank extras captured in onboarding step 3 — live in snapshot JSON
        bankBranch: ownershipSnapshot?.branch || "",
        accountType: ownershipSnapshot?.accountType || "",

        // Owner residential address for sole-proprietorship — snapshot JSON
        ownerAddressLine1: ownershipSnapshot?.ownerAddressLine1 || "",
        ownerCity: ownershipSnapshot?.ownerCity || "",
        ownerDistrict: ownershipSnapshot?.ownerDistrict || "",
        ownerState: ownershipSnapshot?.ownerState || "",
        ownerPinCode: ownershipSnapshot?.ownerPinCode || "",

        // Partner / director lists — read-only reference for admins
        partners: partnersSnapshot,
        directors: directorsSnapshot,

        // Sales manager — prefer structured columns; fall back to snapshot
        salesManagerName: row.sales_manager_name || salesManagerSnapshot?.name || "",
        salesManagerEmail: row.sales_manager_email || salesManagerSnapshot?.email || "",
        salesManagerMobile: row.sales_manager_mobile || salesManagerSnapshot?.mobile || "",

        // ✅ NEW — agreement language preference
        agreementLanguage: row.agreement_language,

        financeEnabled: row.finance_enabled,
        onboardingStatus: row.onboarding_status,
        reviewStatus: row.review_status,
        submittedAt: row.submitted_at,

        correctionRemarks: row.correction_remarks || null,
        rejectionRemarks: row.rejection_remarks || (row as any).rejectionReason || null,

        correctionRound,

        documents,

        agreement: row.finance_enabled
          ? {
              agreementId: row.provider_document_id || null,
              status: row.agreement_status || "not_generated",
              copyUrl: row.provider_signing_url || null,
              signedAgreementUrl: row.signed_agreement_url || null,
              requestId: row.request_id || null,
              stampStatus: row.stamp_status || "pending",
              completionStatus: row.completion_status || "pending",
              signedAt: row.signed_at || null,
              lastActionTimestamp: row.last_action_timestamp || null,

              agreementName: agreementData.agreementName || "",
              agreementVersion: agreementData.agreementVersion || "",
              dateOfSigning: agreementData.dateOfSigning || "",
              mouDate: agreementData.mouDate || "",
              financierName: agreementData.financierName || "",

              dealerSignerName: agreementData.dealerSignerName || "",
              dealerSignerDesignation: agreementData.dealerSignerDesignation || "",
              dealerSignerEmail: agreementData.dealerSignerEmail || "",
              dealerSignerPhone: agreementData.dealerSignerPhone || "",
              dealerSigningMethod: agreementData.dealerSigningMethod || "",

              financierSignatory: agreementData.financierSignatory || null,
              itarangSignatory1: agreementData.itarangSignatory1 || null,
              itarangSignatory2: agreementData.itarangSignatory2 || null,

              signingOrder: agreementData.signingOrder || ["dealer", "financier", "itarang_1", "itarang_2"],

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

    // Never echo error.message to the client — it can leak DB column names,
    // driver internals, or stack-like context. The server log above has the
    // full detail for debugging.
    return NextResponse.json(
      { success: false, message: "Failed to fetch dealer verification detail" },
      { status: 500 }
    );
  }
}

// ─── PATCH — edit company details + agreement language ───────────────────────

export async function PATCH(req: NextRequest, context: RouteContext) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;
  try {
    const { dealerId } = await context.params;
    const rawBody = await req.json();

    const parsed = PatchBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          message: "Invalid request body",
          errors: parsed.error.issues,
        },
        { status: 400 }
      );
    }

    const {
      companyName,
      companyAddress,
      gstNumber,
      panNumber,
      cinNumber,
      companyType,
      ownerName,
      ownerPhone,
      ownerEmail,
      bankName,
      accountNumber,
      beneficiaryName,
      ifscCode,
      agreementLanguage,
      ownerAddressLine1,
      ownerCity,
      ownerDistrict,
      ownerState,
      ownerPinCode,
      bankBranch,
      accountType,
      salesManagerName,
      salesManagerEmail,
      salesManagerMobile,
    } = parsed.data;

    // If this application is a branch dealer (approved against an existing
    // shared accounts row), legal-entity fields are read-only — they live
    // on the parent account and must not be mutated from here.
    const [branchCheck] = await db
      .select({
        isBranchDealer: dealerOnboardingApplications.is_branch_dealer,
      })
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, dealerId))
      .limit(1);

    if (branchCheck?.isBranchDealer) {
      const sharedFieldUpdates: Record<string, unknown> = {
        companyName,
        companyAddress,
        gstNumber,
        panNumber,
        companyType,
        bankName,
        accountNumber,
        beneficiaryName,
        ifscCode,
      };
      const attemptedSharedFields = Object.entries(sharedFieldUpdates)
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k);

      if (attemptedSharedFields.length > 0) {
        return NextResponse.json(
          {
            success: false,
            message:
              "These fields are shared with the primary dealer account and cannot be edited for a branch dealer.",
            readOnlyFields: attemptedSharedFields,
          },
          { status: 403 }
        );
      }
    }

    // Only include fields that were actually sent. Keys must match the
    // snake_case Drizzle field names from the 10af73a schema rename, otherwise
    // .set() throws and the PATCH returns "Failed to update dealer details".
    const updatePayload: Record<string, any> = {};

    if (companyName     !== undefined) updatePayload.company_name      = companyName;
    if (gstNumber       !== undefined) updatePayload.gst_number        = gstNumber;
    if (panNumber       !== undefined) updatePayload.pan_number        = panNumber;
    if (cinNumber       !== undefined) updatePayload.cin_number        = cinNumber;
    if (companyType     !== undefined) updatePayload.company_type      = companyType;
    if (ownerName       !== undefined) updatePayload.owner_name        = ownerName;
    if (ownerPhone      !== undefined) updatePayload.owner_phone       = ownerPhone;
    if (ownerEmail      !== undefined) updatePayload.owner_email       = ownerEmail;
    if (bankName        !== undefined) updatePayload.bank_name         = bankName;
    if (accountNumber   !== undefined) updatePayload.account_number    = accountNumber;
    if (beneficiaryName !== undefined) updatePayload.beneficiary_name  = beneficiaryName;
    if (ifscCode        !== undefined) updatePayload.ifsc_code         = ifscCode;
    if (salesManagerName   !== undefined) updatePayload.sales_manager_name   = salesManagerName;
    if (salesManagerEmail  !== undefined) updatePayload.sales_manager_email  = salesManagerEmail;
    if (salesManagerMobile !== undefined) updatePayload.sales_manager_mobile = salesManagerMobile;

    // Fields that live inside providerRawResponse.submissionSnapshot.ownership
    // (bank branch, account type, owner residential address) or inside
    // providerRawResponse.agreement.salesManager. We need to merge rather than
    // overwrite so other snapshot keys — partners[], directors[], finance,
    // reviewChecks — survive admin edits.
    const ownershipSnapshotKeys = {
      branch: bankBranch,
      accountType: accountType,
      ownerAddressLine1: ownerAddressLine1,
      ownerCity: ownerCity,
      ownerDistrict: ownerDistrict,
      ownerState: ownerState,
      ownerPinCode: ownerPinCode,
    };
    const salesManagerSnapshotKeys = {
      name: salesManagerName,
      email: salesManagerEmail,
      mobile: salesManagerMobile,
    };
    const touchesOwnershipSnapshot = Object.values(ownershipSnapshotKeys).some(
      (v) => v !== undefined,
    );
    const touchesSalesManagerSnapshot = Object.values(salesManagerSnapshotKeys).some(
      (v) => v !== undefined,
    );

    if (touchesOwnershipSnapshot || touchesSalesManagerSnapshot) {
      const [existingRow] = await db
        .select({ providerRawResponse: dealerOnboardingApplications.provider_raw_response })
        .from(dealerOnboardingApplications)
        .where(eq(dealerOnboardingApplications.id, dealerId))
        .limit(1);
      const existingProvider = parseProviderRawResponse(existingRow?.providerRawResponse);
      const existingSnapshot =
        (existingProvider as any)?.submissionSnapshot &&
        typeof (existingProvider as any).submissionSnapshot === "object"
          ? { ...(existingProvider as any).submissionSnapshot }
          : {};
      const existingOwnership =
        existingSnapshot?.ownership && typeof existingSnapshot.ownership === "object"
          ? { ...existingSnapshot.ownership }
          : {};
      const existingAgreement =
        (existingProvider as any)?.agreement && typeof (existingProvider as any).agreement === "object"
          ? { ...(existingProvider as any).agreement }
          : {};
      const existingSalesManager =
        existingAgreement?.salesManager && typeof existingAgreement.salesManager === "object"
          ? { ...existingAgreement.salesManager }
          : {};

      for (const [key, value] of Object.entries(ownershipSnapshotKeys)) {
        if (value !== undefined) existingOwnership[key] = value;
      }
      for (const [key, value] of Object.entries(salesManagerSnapshotKeys)) {
        if (value !== undefined) existingSalesManager[key] = value;
      }

      existingSnapshot.ownership = existingOwnership;
      existingAgreement.salesManager = existingSalesManager;

      updatePayload.provider_raw_response = {
        ...(existingProvider as Record<string, any>),
        submissionSnapshot: existingSnapshot,
        agreement: existingAgreement,
      };
    }

    // businessAddress is a jsonb column holding { address, city, state, pincode, ... }.
    // Merge into the existing object so admins editing the display string don't
    // destroy the structured sub-fields downstream consumers (approve, Digio
    // agreement payload) rely on.
    if (companyAddress !== undefined) {
      const [existing] = await db
        .select({ businessAddress: dealerOnboardingApplications.business_address })
        .from(dealerOnboardingApplications)
        .where(eq(dealerOnboardingApplications.id, dealerId))
        .limit(1);
      // business_address is TEXT — values are JSON-encoded strings (or plain
      // strings). Parse so we preserve sibling keys (city/state/pincode) when
      // an admin edits only the address line.
      let existingAddr: Record<string, unknown> = {};
      const raw = existing?.businessAddress;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        existingAddr = raw as Record<string, unknown>;
      } else if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (trimmed.startsWith("{")) {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              existingAddr = parsed as Record<string, unknown>;
            }
          } catch {
            existingAddr = { address: trimmed };
          }
        } else if (trimmed.length > 0) {
          existingAddr = { address: trimmed };
        }
      }
      // business_address is a TEXT column holding a JSON-encoded object —
      // stringify so Drizzle writes a valid string and the read path
      // (extractAddress) can JSON.parse it back into the structured shape.
      updatePayload.business_address = JSON.stringify({ ...existingAddr, address: companyAddress });
    }

    // agreementLanguage stored in its own column (add to schema — see README below)
    if (agreementLanguage !== undefined) updatePayload.agreement_language = agreementLanguage;

    if (Object.keys(updatePayload).length === 0) {
      return NextResponse.json(
        { success: false, message: "No fields provided to update" },
        { status: 400 }
      );
    }

    const updated = await db
      .update(dealerOnboardingApplications)
      .set(updatePayload)
      .where(eq(dealerOnboardingApplications.id, dealerId))
      .returning({ id: dealerOnboardingApplications.id });

    if (updated.length === 0) {
      return NextResponse.json(
        { success: false, message: "Dealer not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, message: "Dealer details updated successfully" });
  } catch (error: any) {
    console.error("ADMIN DEALER PATCH ERROR:", error);
    return NextResponse.json(
      { success: false, message: "Failed to update dealer details" },
      { status: 500 }
    );
  }
}