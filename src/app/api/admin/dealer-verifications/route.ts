import { NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { dealerOnboardingApplications, dealerOnboardingDocuments } from "@/lib/db/schema";
import { and, desc, isNotNull, ne, notInArray, or, sql } from "drizzle-orm";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import { classifyApplicationsBatch } from "@/lib/dealer/duplicate-check";
import { type CompanyType, requiredDocuments } from "@/lib/whatsapp/checklist";
import { buildLocationHaystack } from "@/lib/dealer/location-haystack";
import { approvalTagsFor } from "@/lib/dealer/approval-tag";

export async function GET() {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;
  try {
    const applications = await db
      .select({
        id: dealerOnboardingApplications.id,
        companyName: dealerOnboardingApplications.company_name,
        companyType: dealerOnboardingApplications.company_type,
        // E-202 — dealer business type (new | scrap | both); drives the queue's
        // dealer-type badge and filter.
        dealerType: dealerOnboardingApplications.dealer_type,
        gstNumber: dealerOnboardingApplications.gst_number,
        panNumber: dealerOnboardingApplications.pan_number,
        businessAddress: dealerOnboardingApplications.business_address,
        registeredAddress: dealerOnboardingApplications.registered_address,
        providerRawResponse: dealerOnboardingApplications.provider_raw_response,
        dealerCode: dealerOnboardingApplications.dealer_code,
        financeEnabled: dealerOnboardingApplications.finance_enabled,
        onboardingStatus: dealerOnboardingApplications.onboarding_status,
        reviewStatus: dealerOnboardingApplications.review_status,
        agreementStatus: dealerOnboardingApplications.agreement_status,
        dealerAccountStatus: dealerOnboardingApplications.dealer_account_status,
        isBranchDealer: dealerOnboardingApplications.is_branch_dealer,
        submittedAt: dealerOnboardingApplications.submitted_at,
        approvedAt: dealerOnboardingApplications.approved_at,
        approvedBy: dealerOnboardingApplications.approved_by,
        updatedAt: dealerOnboardingApplications.updated_at,
        createdAt: dealerOnboardingApplications.created_at,
        city: dealerOnboardingApplications.city,
        state: dealerOnboardingApplications.state,
        pincode: dealerOnboardingApplications.pincode,
        ownerName: dealerOnboardingApplications.owner_name,
        ownerEmail: dealerOnboardingApplications.owner_email,
        salesManagerName: dealerOnboardingApplications.sales_manager_name,
        salesManagerEmail: dealerOnboardingApplications.sales_manager_email,
        salesManagerMobile: dealerOnboardingApplications.sales_manager_mobile,
        // E-167: collection channel + bot-surfaced verification warnings so the
        // queue can badge WhatsApp-collected applications and flag failed checks.
        source: dealerOnboardingApplications.source,
        verificationWarnings: dealerOnboardingApplications.verification_warnings,
      })
      .from(dealerOnboardingApplications)
      // Hide rows the dealer never finished. A pure draft (status = "draft"
      // AND submitted_at IS NULL) is in-progress dealer work that admins
      // can't action anyway — including it just produces the misleading
      // "Dealer onboarding must be submitted before approval." alert when
      // an admin opens the row and clicks Approve. Submitted, approved,
      // rejected, and correction_requested rows are still returned.
      .where(
        or(
          ne(dealerOnboardingApplications.onboarding_status, "draft"),
          isNotNull(dealerOnboardingApplications.submitted_at),
        ),
      )
      .orderBy(
        desc(dealerOnboardingApplications.updated_at),
        desc(dealerOnboardingApplications.created_at)
      );

    if (applications.length === 0) {
      return NextResponse.json({ success: true, applications: [] });
    }

    const applicationIds = applications.map((a) => a.id);
    const approvalTags = await approvalTagsFor(applications.map((a) => a.approvedBy));

    // Count DISTINCT document types per application (not raw rows) and ignore
    // superseded / pending_correction history — so the badge matches the unique
    // set of documents the detail page shows, even if a dealer re-sent some.
    const docCounts = await db
      .select({
        applicationId: dealerOnboardingDocuments.application_id,
        count: sql<number>`cast(count(distinct ${dealerOnboardingDocuments.document_type}) as integer)`,
      })
      .from(dealerOnboardingDocuments)
      .where(
        and(
          sql`${dealerOnboardingDocuments.application_id} = ANY(ARRAY[${sql.join(
            applicationIds.map((id) => sql`${id}::uuid`),
            sql`, `
          )}])`,
          notInArray(dealerOnboardingDocuments.doc_status, [
            "superseded",
            "pending_correction",
          ]),
        )
      )
      .groupBy(dealerOnboardingDocuments.application_id);

    // Also gather the DISTINCT document types present per application, to compute
    // which required documents are still missing (WhatsApp onboarding).
    const typeRows = await db
      .select({
        applicationId: dealerOnboardingDocuments.application_id,
        documentType: dealerOnboardingDocuments.document_type,
      })
      .from(dealerOnboardingDocuments)
      .where(
        and(
          sql`${dealerOnboardingDocuments.application_id} = ANY(ARRAY[${sql.join(
            applicationIds.map((id) => sql`${id}::uuid`),
            sql`, `
          )}])`,
          notInArray(dealerOnboardingDocuments.doc_status, [
            "superseded",
            "pending_correction",
          ]),
        )
      );
    const typesByApp = new Map<string, Set<string>>();
    for (const r of typeRows) {
      const set = typesByApp.get(r.applicationId) ?? new Set<string>();
      set.add(r.documentType);
      typesByApp.set(r.applicationId, set);
    }

    // Build a quick lookup map: applicationId → document count
    const docCountMap = new Map<string, number>();
    for (const row of docCounts) {
      docCountMap.set(row.applicationId, row.count);
    }

    // Batch-classify GSTIN conflicts in a SINGLE accounts query (no N+1).
    // Rows already approved as branches of another account are deliberately
    // kept flagged as `branch` so admins can see the linkage.
    const classificationMap = await classifyApplicationsBatch(
      applications.map((a) => ({
        id: a.id,
        gst_number: a.gstNumber,
        pan_number: a.panNumber,
        business_address: a.businessAddress as string | null,
        dealer_code: a.dealerCode,
      })),
    );

    // Shape the response for the admin dashboard table
    const formatted = applications.map((item) => {
      const docCount = docCountMap.get(item.id) ?? 0;
      const classification = classificationMap.get(item.id);
      const duplicateFlag = classification?.conflict ?? "none";
      const onboardingStatus = (item.onboardingStatus || "draft").toLowerCase();
      const reviewStatus = (item.reviewStatus || "").toLowerCase();

      // Which required documents are still missing (WhatsApp onboarding — the
      // checklist is entity-type specific). For web dealers we don't compute
      // this, since they follow a different document set.
      const isWhatsApp = (item.source || "web").toLowerCase() === "whatsapp";
      const uploadedTypes = typesByApp.get(item.id) ?? new Set<string>();
      const missingDocuments = isWhatsApp
        ? requiredDocuments(item.companyType as CompanyType | null)
            .filter((d) => !uploadedTypes.has(d.type))
            .map((d) => d.label)
        : [];

      // Human-readable document badge value (+ a "N missing" hint when known)
      const documentsLabel =
        docCount === 0
          ? "None uploaded"
          : missingDocuments.length > 0
            ? `${docCount} uploaded · ${missingDocuments.length} missing`
            : `${docCount} uploaded`;

      // Human-readable agreement badge value
      // If finance is not enabled, agreement is not applicable
      // Otherwise, surface the real agreement status from the DB
      const agreementLabel = !item.financeEnabled
        ? "N/A"
        : item.agreementStatus?.trim() || "not_generated";
      const status =
        onboardingStatus === "approved" ||
        onboardingStatus === "rejected" ||
        onboardingStatus === "correction_requested"
          ? onboardingStatus
          : reviewStatus && reviewStatus !== "draft"
            ? reviewStatus
            : onboardingStatus;

      return {
        dealerId: item.id,
        // Use ownerName as the dealer display name; fall back to company name
        dealerName: item.ownerName || item.companyName || "—",
        companyName: item.companyName || "—",
        dealerDisplayName:
          item.ownerName || item.companyName || item.ownerEmail || "—",
        documents: documentsLabel,
        // Names of required documents not yet uploaded (WhatsApp dealers only).
        missingDocuments,
        agreement: agreementLabel,
        // Raw agreement status (lowercased) for the agreement-status filter +
        // CSV. "pending" in the filter maps to: finance-enabled, initiated, and
        // not completed/failed/expired.
        agreementStatus: (item.agreementStatus || "").toLowerCase(),
        // The admin table StatusBadge reads `status` — map from onboardingStatus
        legacyStatus: item.onboardingStatus ?? "draft",
        status,
        dealerAccountStatus: (item.dealerAccountStatus || "").toLowerCase(),
        submittedAt: item.submittedAt,
        approvedAt: item.approvedAt,
        // "CEO approved" | "Admin approved" | null (legacy rows without approved_by)
        approvedByTag:
          item.onboardingStatus === "approved" && item.approvedBy
            ? approvalTags.get(item.approvedBy) ?? null
            : null,
        city: item.city || "",
        state: item.state || "",
        pincode: item.pincode || "",
        // Combined location haystack (flat columns + free-text address +
        // submissionSnapshot owner address & GST places) so the
        // state/city/pincode filters work even when the flat columns are empty —
        // which they are for most web/WhatsApp onboarding rows.
        location: buildLocationHaystack({
          city: item.city,
          state: item.state,
          pincode: item.pincode,
          business_address: item.businessAddress,
          registered_address: item.registeredAddress,
          provider_raw_response: item.providerRawResponse,
        }),
        gstNumber: item.gstNumber,
        financeEnabled: item.financeEnabled,
        companyType: item.companyType,
        // Null for applications submitted before E-202 — the UI badges those as
        // "Not specified" rather than hiding them.
        dealerType: item.dealerType || null,
        salesManagerName: item.salesManagerName,
        salesManagerEmail: item.salesManagerEmail,
        salesManagerMobile: item.salesManagerMobile,
        duplicateFlag,
        isBranchDealer: item.isBranchDealer,
        // E-167: 'web' (default) | 'whatsapp'. warningCount drives a red flag on
        // the row so admins notice bot checks that failed/mismatched.
        source: (item.source || "web").toLowerCase(),
        warningCount: Array.isArray(item.verificationWarnings)
          ? item.verificationWarnings.length
          : 0,
      };
    });

    return NextResponse.json({
      success: true,
      applications: formatted,
    });
  } catch (error: any) {
    console.error("ADMIN DEALER VERIFICATIONS LIST ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: "Failed to fetch dealer verifications",
      },
      { status: 500 }
    );
  }
}
