import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import {
  dealerCorrectionItems,
  dealerCorrectionRounds,
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
  dealers,
} from "@/lib/db/schema";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import {
  documentLabel,
  fieldLabel,
} from "@/lib/onboarding/correction-catalog";
import { type CompanyType, requiredDocuments } from "@/lib/whatsapp/checklist";
import { normalizeAccountType } from "@/lib/onboarding/account-type";
import { viewableFileUrl } from "@/lib/storage/legacyUrl";
import { extractAddress, gstPrincipalAddress } from "@/lib/onboarding/dealer-address";
import {
  agreementModeFor,
  usesManualAgreement,
} from "@/lib/dealer/dealer-capabilities";

const AddressRoleEnum = z.enum(["billing", "dispatch", "other"]);
const GstAddressSchema = z.object({
  id: z.string(),
  label: z.string().optional().default(""),
  addressLine1: z.string().optional().default(""),
  city: z.string().optional().default(""),
  district: z.string().optional().default(""),
  state: z.string().optional().default(""),
  pincode: z.string().optional().default(""),
  raw: z.string().optional().default(""),
  roles: z.array(AddressRoleEnum).optional().default([]),
});
const GstAddressesSchema = z.object({
  additionalCount: z.number().optional(),
  principal: GstAddressSchema,
  additional: z.array(GstAddressSchema).optional().default([]),
});

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
  // Owner's 12-digit Aadhaar — required before a dealer Aadhaar e-sign can be
  // matched against the owner's Aadhaar card (E-175). Lets an admin capture it
  // for dealers onboarded before the field existed.
  ownerAadhaarNo: z.string().optional(),
  bankName: z.string().optional(),
  accountNumber: z.string().optional(),
  beneficiaryName: z.string().optional(),
  // IFSC is varchar(11) on accounts.ifsc_code — an over-long or malformed code
  // (WhatsApp onboarding extracts it from a cheque/passbook photo, so OCR can
  // add or drop a digit) sails through onboarding and only explodes at
  // approval time as a raw "value too long for type character varying(11)"
  // 500. Validate the canonical RBI shape here so it is caught at the point
  // the admin can actually fix it.
  ifscCode: z
    .string()
    .optional()
    .transform((v) => (typeof v === "string" ? v.trim().toUpperCase() : v))
    .refine((v) => !v || /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v), {
      message:
        "IFSC code must be 11 characters: 4 letters, then 0, then 6 letters/digits (e.g. HDFC0000516).",
    }),
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

  // GST Places of Business + admin billing/dispatch/other role tags —
  // persisted whole into providerRawResponse.submissionSnapshot.gstAddresses
  gstAddresses: GstAddressesSchema.optional(),
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

// Build the gstAddresses payload for the review page. Prefer the value stored
// in the snapshot (WhatsApp-extracted or web GST-OCR); when absent (older
// dealers / manual web entry) synthesize a single principal card from the
// existing company address columns so the UI always has at least one card.
function buildGstAddressesResponse(
  snapshotGst: any,
  fallback: { companyAddress: string; city?: string | null; state?: string | null; pincode?: string | null },
) {
  if (snapshotGst && typeof snapshotGst === "object" && snapshotGst.principal) {
    const norm = (a: any, id: string, label: string) => ({
      id: a?.id || id,
      label: a?.label || label,
      addressLine1: a?.addressLine1 || "",
      city: a?.city || "",
      district: a?.district || "",
      state: a?.state || "",
      pincode: a?.pincode || "",
      raw: a?.raw || "",
      roles: Array.isArray(a?.roles) ? a.roles : [],
    });
    const additional = Array.isArray(snapshotGst.additional) ? snapshotGst.additional : [];
    return {
      additionalCount:
        typeof snapshotGst.additionalCount === "number"
          ? snapshotGst.additionalCount
          : additional.length,
      principal: norm(snapshotGst.principal, "principal", "Principal Place of Business"),
      additional: additional.map((a: any, i: number) =>
        norm(a, `add-${i + 1}`, `Additional Place ${i + 1}`),
      ),
    };
  }
  // Synthesized fallback — principal carries both roles by default.
  return {
    additionalCount: 0,
    principal: {
      id: "principal",
      label: "Principal Place of Business",
      addressLine1: "",
      city: fallback.city || "",
      district: "",
      state: fallback.state || "",
      pincode: fallback.pincode || "",
      raw: fallback.companyAddress || "",
      roles: ["billing", "dispatch"],
    },
    additional: [],
  };
}

// ─── GET ────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest, context: RouteContext) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;
  try {
    const { dealerId } = await context.params;

    // Application + documents are both keyed by the same id (row.id === dealerId),
    // so fetch them in parallel rather than awaiting one before the other.
    // Documents query hides superseded (replaced via correction round) and
    // pending_correction documents (those belong to the in-flight correction
    // card, not the main verification list).
    const [application, allDocuments] = await Promise.all([
      db
        .select()
        .from(dealerOnboardingApplications)
        .where(eq(dealerOnboardingApplications.id, dealerId)),
      db
        .select()
        .from(dealerOnboardingDocuments)
        .where(
          and(
            eq(dealerOnboardingDocuments.application_id, dealerId),
            ne(dealerOnboardingDocuments.doc_status, "superseded"),
            ne(dealerOnboardingDocuments.doc_status, "pending_correction"),
          ),
        ),
    ]);

    const row = application[0];

    if (!row) {
      return NextResponse.json(
        { success: false, message: "Dealer onboarding application not found" },
        { status: 404 }
      );
    }

    // Whether financing is actually LIVE for this dealer, as opposed to merely
    // requested on the application. These diverge during post-approval finance
    // enablement: `financeEnabled` flips to true when the admin clicks Enable
    // Finance, but `financeLive` only follows once the agreement is signed and
    // Activate Finance runs. `dealers.finance_enabled` is the column the E-105
    // lead-creation gate and the WhatsApp console both read.
    let financeLive = false;
    if (row.dealer_code) {
      const [dealerRow] = await db
        .select({ financeEnabled: dealers.finance_enabled })
        .from(dealers)
        .where(eq(dealers.dealer_id, row.dealer_code))
        .limit(1);
      financeLive = Boolean(dealerRow?.financeEnabled);
    }

    // Keep only the most recent upload per document_type so the admin sees a
    // single fresh row per item — no stale duplicates after re-upload.

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
      // Legacy rows hold an absolute URL on the now-deleted Supabase project;
      // rewrite to the /api/files proxy so the link resolves (E-251 backfill
      // does the same in the DB — this covers envs it has not reached yet).
      url: viewableFileUrl(doc.file_url) || "",
      docStatus: doc.doc_status,
      verificationStatus: doc.verification_status,
      uploadedAt: doc.uploaded_at,
      rejectionReason: doc.rejection_reason,
    }));

    // Required documents not yet uploaded (WhatsApp onboarding — the checklist
    // is entity-type specific). Surfaced as an alert on the review page so the
    // admin can see exactly what's outstanding for this dealer. Web dealers
    // follow a different document set, so we don't flag missing docs for them.
    const uploadedTypes = new Set(documents.map((d) => d.documentType));
    const missingDocuments =
      (row.source || "web").toLowerCase() === "whatsapp"
        ? requiredDocuments(row.company_type as CompanyType | null)
            .filter((d) => !uploadedTypes.has(d.type))
            .map((d) => ({ type: d.type, label: d.label }))
        : [];

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

    const gstAddressesSnapshot = (providerData as any)?.submissionSnapshot?.gstAddresses;
    // Company Address: prefer the business_address column; fall back to the GST
    // Principal Place of Business (always captured in the snapshot) so WhatsApp
    // dealers whose column was never written still show an address.
    const companyAddress =
      extractAddress(row.business_address) || gstPrincipalAddress(gstAddressesSnapshot);
    // Account Type: ONLY surface a value that a bank document actually stated
    // (normalised to 'savings'/'current'). We deliberately do NOT infer it from
    // the holder/company name — when no document prints it, leave it blank so the
    // admin UI flags it as "Not available / Missing" for manual review.
    const accountType = normalizeAccountType(ownershipSnapshot?.accountType);

    return NextResponse.json({
      success: true,
      data: {
        id: row.id,
        dealerId: row.id,

        companyName: row.company_name,
        companyAddress,
        gstNumber: row.gst_number,
        panNumber: row.pan_number,
        // cinNumber: row.cinNumber,
        companyType: row.company_type,
        // E-202 dealer business type (new | scrap | both) — what the dealer
        // sells, as opposed to companyType (legal structure). Null for
        // applications submitted before the field existed.
        dealerType: row.dealer_type || null,

        ownerName: row.owner_name,
        ownerPhone: row.owner_phone,
        ownerEmail: row.owner_email,
        ownerAadhaarNo: row.owner_aadhaar_no || "",

        bankName: row.bank_name,
        accountNumber: row.account_number,
        beneficiaryName: row.beneficiary_name,
        ifscCode: row.ifsc_code,

        // Bank extras captured in onboarding step 3 — live in snapshot JSON
        bankBranch: ownershipSnapshot?.branch || "",
        accountType,

        // Owner residential address for sole-proprietorship — snapshot JSON
        ownerAddressLine1: ownershipSnapshot?.ownerAddressLine1 || "",
        ownerCity: ownershipSnapshot?.ownerCity || "",
        ownerDistrict: ownershipSnapshot?.ownerDistrict || "",
        ownerState: ownershipSnapshot?.ownerState || "",
        ownerPinCode: ownershipSnapshot?.ownerPinCode || "",

        // GST Places of Business (principal + additional) with billing/dispatch/
        // other role tags. Synthesized from company address for older dealers.
        gstAddresses: buildGstAddressesResponse(gstAddressesSnapshot, {
          companyAddress,
          city: row.city,
          state: row.state,
          pincode: row.pincode,
        }),

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
        financeLive,
        onboardingStatus: row.onboarding_status,
        reviewStatus: row.review_status,
        submittedAt: row.submitted_at,

        // E-167: collection channel + bot-surfaced warnings. For WhatsApp-
        // collected applications the values were auto-extracted (Gemini) and
        // verified (Decentro); warnings list any check that failed/mismatched so
        // nothing passes silently (design §8, §16).
        source: (row.source || "web").toLowerCase(),
        waPhone: row.wa_phone || null,
        verificationWarnings: Array.isArray(row.verification_warnings)
          ? row.verification_warnings
          : [],

        correctionRemarks: row.correction_remarks || null,
        rejectionRemarks: row.rejection_remarks || (row as any).rejectionReason || null,

        correctionRound,

        documents,
        // Required-but-not-uploaded documents (WhatsApp dealers) — drives the
        // "missing documents" alert in Section 2 of the review page.
        missingDocuments,

        // E-225 — manual-mode dealers (scrap / new+scrap) need this block even
        // with finance off: their agreement is not a finance agreement, and
        // gating on finance_enabled would leave the review page with nothing to
        // show for the paper copy they actually signed.
        agreement: row.finance_enabled || usesManualAgreement(row.dealer_type)
          ? {
              agreementId: row.provider_document_id || null,
              status: row.agreement_status || "not_generated",
              // How it was executed, and the paper's own provenance.
              mode: row.agreement_mode || agreementModeFor(row.dealer_type),
              agreementRef: row.agreement_ref || null,
              agreementSignedOn: row.agreement_signed_on || null,
              copyUrl: row.provider_signing_url || null,
              signedAgreementUrl: viewableFileUrl(row.signed_agreement_url) || null,
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
      // Surface the actual field message — a bare "Invalid request body" gives
      // the admin nothing to act on when e.g. the IFSC fails its format check.
      const firstIssue = parsed.error.issues[0];
      const fieldPath = firstIssue?.path?.join(".") || "";
      return NextResponse.json(
        {
          success: false,
          message: firstIssue
            ? `${fieldPath ? `${fieldPath}: ` : ""}${firstIssue.message}`
            : "Invalid request body",
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
      ownerAadhaarNo,
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
      gstAddresses,
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
    if (ownerAadhaarNo  !== undefined) {
      // Store only a valid 12-digit Aadhaar; blank/invalid clears it so the
      // E-175 guard keeps blocking until a real number is on file.
      const digits = String(ownerAadhaarNo).replace(/\D/g, "");
      updatePayload.owner_aadhaar_no = digits.length === 12 ? digits : null;
    }
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
    const touchesGstAddresses = gstAddresses !== undefined;
    // The dealer agreement signer (Section 3 "Primary Signer") is the primary
    // contact. Its values live in provider_raw_response.agreement.dealerSigner*,
    // and both Section 3's display and initiate-agreement PRIORITISE those stored
    // values over owner_name/owner_email. So when an admin edits the primary
    // contact in Section 1, we must mirror it into the agreement blob — otherwise
    // Section 3 (and the generated Digio agreement) keep the pre-edit signer.
    const touchesDealerSigner =
      ownerName !== undefined ||
      ownerEmail !== undefined ||
      ownerPhone !== undefined;

    if (
      touchesOwnershipSnapshot ||
      touchesSalesManagerSnapshot ||
      touchesGstAddresses ||
      touchesDealerSigner
    ) {
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

      // Keep the dealer signer in lock-step with the edited primary contact so
      // Section 3 and the Digio agreement always reflect the latest name/email.
      if (ownerName  !== undefined) existingAgreement.dealerSignerName  = ownerName;
      if (ownerEmail !== undefined) existingAgreement.dealerSignerEmail = ownerEmail;
      if (ownerPhone !== undefined) existingAgreement.dealerSignerPhone = ownerPhone;

      existingSnapshot.ownership = existingOwnership;
      existingAgreement.salesManager = existingSalesManager;

      // Replace the whole gstAddresses object with the admin's edited version
      // (role tags + any added/removed/edited address cards).
      if (touchesGstAddresses) {
        existingSnapshot.gstAddresses = gstAddresses;
      }

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