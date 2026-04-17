import { NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { dealerOnboardingApplications, dealerOnboardingDocuments } from "@/lib/db/schema";
import { desc, sql } from "drizzle-orm";

export async function GET() {
  try {
    const applications = await db
      .select({
        id: dealerOnboardingApplications.id,
        companyName: dealerOnboardingApplications.companyName,
        companyType: dealerOnboardingApplications.companyType,
        gstNumber: dealerOnboardingApplications.gstNumber,
        financeEnabled: dealerOnboardingApplications.financeEnabled,
        onboardingStatus: dealerOnboardingApplications.onboardingStatus,
        reviewStatus: dealerOnboardingApplications.reviewStatus,
        agreementStatus: dealerOnboardingApplications.agreementStatus,
        submittedAt: dealerOnboardingApplications.submittedAt,
        updatedAt: dealerOnboardingApplications.updatedAt,
        createdAt: dealerOnboardingApplications.createdAt,
        ownerName: dealerOnboardingApplications.ownerName,
        ownerEmail: dealerOnboardingApplications.ownerEmail,
      })
      .from(dealerOnboardingApplications)
      .orderBy(
        desc(dealerOnboardingApplications.updatedAt),
        desc(dealerOnboardingApplications.createdAt)
      );

    if (applications.length === 0) {
      return NextResponse.json({ success: true, applications: [] });
    }

    const applicationIds = applications.map((a) => a.id);

    const docCounts = await db
      .select({
        applicationId: dealerOnboardingDocuments.applicationId,
        count: sql<number>`cast(count(*) as integer)`,
      })
      .from(dealerOnboardingDocuments)
      .where(
        sql`${dealerOnboardingDocuments.applicationId} = ANY(ARRAY[${sql.join(
          applicationIds.map((id) => sql`${id}::uuid`),
          sql`, `
        )}])`
      )
      .groupBy(dealerOnboardingDocuments.applicationId);

    // Build a quick lookup map: applicationId → document count
    const docCountMap = new Map<string, number>();
    for (const row of docCounts) {
      docCountMap.set(row.applicationId, row.count);
    }

    // Shape the response for the admin dashboard table
    const formatted = applications.map((item) => {
      const docCount = docCountMap.get(item.id) ?? 0;
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
        message:
          error?.message || "Failed to fetch dealer verifications",
      },
      { status: 500 }
    );
  }
}
