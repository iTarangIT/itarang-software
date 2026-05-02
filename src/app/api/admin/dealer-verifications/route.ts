import { NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { dealerOnboardingApplications, dealerOnboardingDocuments } from "@/lib/db/schema";
import { desc, isNotNull, ne, or, sql } from "drizzle-orm";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import { classifyApplicationsBatch } from "@/lib/dealer/duplicate-check";

export async function GET() {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;
  try {
    const applications = await db
      .select({
        id: dealerOnboardingApplications.id,
        companyName: dealerOnboardingApplications.company_name,
        companyType: dealerOnboardingApplications.company_type,
        gstNumber: dealerOnboardingApplications.gst_number,
        panNumber: dealerOnboardingApplications.pan_number,
        businessAddress: dealerOnboardingApplications.business_address,
        dealerCode: dealerOnboardingApplications.dealer_code,
        financeEnabled: dealerOnboardingApplications.finance_enabled,
        onboardingStatus: dealerOnboardingApplications.onboarding_status,
        reviewStatus: dealerOnboardingApplications.review_status,
        agreementStatus: dealerOnboardingApplications.agreement_status,
        isBranchDealer: dealerOnboardingApplications.is_branch_dealer,
        submittedAt: dealerOnboardingApplications.submitted_at,
        updatedAt: dealerOnboardingApplications.updated_at,
        createdAt: dealerOnboardingApplications.created_at,
        ownerName: dealerOnboardingApplications.owner_name,
        ownerEmail: dealerOnboardingApplications.owner_email,
        salesManagerName: dealerOnboardingApplications.sales_manager_name,
        salesManagerEmail: dealerOnboardingApplications.sales_manager_email,
        salesManagerMobile: dealerOnboardingApplications.sales_manager_mobile,
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

    const docCounts = await db
      .select({
        applicationId: dealerOnboardingDocuments.application_id,
        count: sql<number>`cast(count(*) as integer)`,
      })
      .from(dealerOnboardingDocuments)
      .where(
        sql`${dealerOnboardingDocuments.application_id} = ANY(ARRAY[${sql.join(
          applicationIds.map((id) => sql`${id}::uuid`),
          sql`, `
        )}])`
      )
      .groupBy(dealerOnboardingDocuments.application_id);

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

      // Human-readable document badge value
      const documentsLabel =
        docCount === 0
          ? "None uploaded"
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
        agreement: agreementLabel,
        // The admin table StatusBadge reads `status` — map from onboardingStatus
        legacyStatus: item.onboardingStatus ?? "draft",
        status,
        submittedAt: item.submittedAt,
        gstNumber: item.gstNumber,
        financeEnabled: item.financeEnabled,
        companyType: item.companyType,
        salesManagerName: item.salesManagerName,
        salesManagerEmail: item.salesManagerEmail,
        salesManagerMobile: item.salesManagerMobile,
        duplicateFlag,
        isBranchDealer: item.isBranchDealer,
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
