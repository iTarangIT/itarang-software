import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import {
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";

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

    return NextResponse.json(
      { success: false, message: error?.message || "Failed to fetch dealer verification detail" },
      { status: 500 }
    );
  }
}

// ─── PATCH — edit company details + agreement language ───────────────────────

export async function PATCH(req: NextRequest, context: RouteContext) {
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
    if (companyAddress  !== undefined) updatePayload.businessAddress = companyAddress;

    // agreementLanguage stored in its own column (add to schema — see README below)
    if (agreementLanguage !== undefined) updatePayload.agreementLanguage = agreementLanguage;

    if (Object.keys(updatePayload).length === 0) {
      return NextResponse.json(
        { success: false, message: "No fields provided to update" },
        { status: 400 }
      );
    }

    await db
      .update(dealerOnboardingApplications)
      .set(updatePayload)
      .where(eq(dealerOnboardingApplications.id, dealerId));

    return NextResponse.json({ success: true, message: "Dealer details updated successfully" });
  } catch (error: any) {
    console.error("ADMIN DEALER PATCH ERROR:", error);
    return NextResponse.json(
      { success: false, message: error?.message || "Failed to update dealer details" },
      { status: 500 }
    );
  }
}