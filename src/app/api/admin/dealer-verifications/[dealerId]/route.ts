import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import {
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";

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
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, any>;
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

        companyName: row.companyName,
        companyAddress: extractAddress(row.businessAddress),
        gstNumber: row.gstNumber,
        panNumber: row.panNumber,
        // cinNumber: row.cinNumber,
        companyType: row.companyType,

        ownerName: row.ownerName,
        ownerPhone: row.ownerPhone,
        ownerEmail: row.ownerEmail,

        bankName: row.bankName,
        accountNumber: row.accountNumber,
        beneficiaryName: row.beneficiaryName,
        ifscCode: row.ifscCode,

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
        salesManagerName: row.salesManagerName || salesManagerSnapshot?.name || "",
        salesManagerEmail: row.salesManagerEmail || salesManagerSnapshot?.email || "",
        salesManagerMobile: row.salesManagerMobile || salesManagerSnapshot?.mobile || "",

        // ✅ NEW — agreement language preference
        agreementLanguage: row.agreementLanguage,

        financeEnabled: row.financeEnabled,
        onboardingStatus: row.onboardingStatus,
        reviewStatus: row.reviewStatus,
        submittedAt: row.submittedAt,

        correctionRemarks: row.correctionRemarks || null,
        rejectionRemarks: row.rejectionRemarks || (row as any).rejectionReason || null,

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

    // Only include fields that were actually sent
    const updatePayload: Record<string, any> = {};

    if (companyName     !== undefined) updatePayload.companyName     = companyName;
    if (gstNumber       !== undefined) updatePayload.gstNumber       = gstNumber;
    if (panNumber       !== undefined) updatePayload.panNumber       = panNumber;
    if (cinNumber       !== undefined) updatePayload.cinNumber       = cinNumber;
    if (companyType     !== undefined) updatePayload.companyType     = companyType;
    if (ownerName       !== undefined) updatePayload.ownerName       = ownerName;
    if (ownerPhone      !== undefined) updatePayload.ownerPhone      = ownerPhone;
    if (ownerEmail      !== undefined) updatePayload.ownerEmail      = ownerEmail;
    if (bankName        !== undefined) updatePayload.bankName        = bankName;
    if (accountNumber   !== undefined) updatePayload.accountNumber   = accountNumber;
    if (beneficiaryName !== undefined) updatePayload.beneficiaryName = beneficiaryName;
    if (ifscCode        !== undefined) updatePayload.ifscCode        = ifscCode;
    if (salesManagerName   !== undefined) updatePayload.salesManagerName   = salesManagerName;
    if (salesManagerEmail  !== undefined) updatePayload.salesManagerEmail  = salesManagerEmail;
    if (salesManagerMobile !== undefined) updatePayload.salesManagerMobile = salesManagerMobile;

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
        .select({ providerRawResponse: dealerOnboardingApplications.providerRawResponse })
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

      updatePayload.providerRawResponse = {
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
        .select({ businessAddress: dealerOnboardingApplications.businessAddress })
        .from(dealerOnboardingApplications)
        .where(eq(dealerOnboardingApplications.id, dealerId))
        .limit(1);
      const existingAddr =
        existing?.businessAddress &&
        typeof existing.businessAddress === "object" &&
        !Array.isArray(existing.businessAddress)
          ? (existing.businessAddress as Record<string, unknown>)
          : {};
      updatePayload.businessAddress = { ...existingAddr, address: companyAddress };
    }

    // agreementLanguage stored in its own column (add to schema — see README below)
    if (agreementLanguage !== undefined) updatePayload.agreementLanguage = agreementLanguage;

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