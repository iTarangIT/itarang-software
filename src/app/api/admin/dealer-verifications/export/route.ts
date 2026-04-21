import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import {
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
} from "@/lib/db/schema";
import { and, desc, gte, ilike, lte, or, sql } from "drizzle-orm";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";

// Parse "YYYY-MM-DD" as local midnight so the day boundary aligns with what
// the admin picked in the UI (mirrors parseLocalDate in the page component).
function parseLocalDate(value: string | null): Date | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function endOfLocalDay(value: string | null): Date | null {
  const d = parseLocalDate(value);
  if (!d) return null;
  d.setHours(23, 59, 59, 999);
  return d;
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  let str: string;
  if (value instanceof Date) {
    str = value.toISOString();
  } else if (typeof value === "boolean") {
    str = value ? "Yes" : "No";
  } else {
    str = String(value);
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatAddress(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const a = raw as Record<string, unknown>;
  const parts = [
    a.line1,
    a.line2,
    a.city,
    a.state,
    a.pincode,
    a.country,
  ]
    .map((p) => (p == null ? "" : String(p).trim()))
    .filter((p) => p.length > 0);
  return parts.join(", ");
}

export async function GET(req: NextRequest) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;

  try {
    const url = new URL(req.url);
    const dateFromRaw = url.searchParams.get("dateFrom");
    const dateToRaw = url.searchParams.get("dateTo");
    const q = (url.searchParams.get("q") || "").trim();

    const dateFrom = parseLocalDate(dateFromRaw);
    const dateTo = endOfLocalDay(dateToRaw);

    const conditions = [];
    if (dateFrom) {
      conditions.push(gte(dealerOnboardingApplications.submittedAt, dateFrom));
    }
    if (dateTo) {
      conditions.push(lte(dealerOnboardingApplications.submittedAt, dateTo));
    }
    if (q) {
      const like = `%${q}%`;
      const search = or(
        ilike(dealerOnboardingApplications.ownerName, like),
        ilike(dealerOnboardingApplications.companyName, like),
        ilike(dealerOnboardingApplications.gstNumber, like),
        ilike(dealerOnboardingApplications.onboardingStatus, like),
        ilike(dealerOnboardingApplications.companyType, like),
      );
      if (search) conditions.push(search);
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const applications = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(whereClause)
      .orderBy(
        desc(dealerOnboardingApplications.updatedAt),
        desc(dealerOnboardingApplications.createdAt),
      );

    const docCountMap = new Map<string, number>();
    if (applications.length > 0) {
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
            sql`, `,
          )}])`,
        )
        .groupBy(dealerOnboardingDocuments.applicationId);

      for (const row of docCounts) {
        docCountMap.set(row.applicationId, row.count);
      }
    }

    const headers = [
      "Dealer ID",
      "Dealer Code",
      "Company Name",
      "Company Type",
      "GST Number",
      "PAN Number",
      "CIN Number",
      "Owner Name",
      "Owner Email",
      "Owner Phone",
      "Owner Landline",
      "Sales Manager Name",
      "Sales Manager Email",
      "Sales Manager Mobile",
      "Business Address",
      "Registered Address",
      "Bank Name",
      "Account Number",
      "Beneficiary Name",
      "IFSC Code",
      "Onboarding Status",
      "Review Status",
      "Dealer Account Status",
      "Finance Enabled",
      "Documents Uploaded",
      "Agreement Status",
      "Agreement Language",
      "Stamp Status",
      "Completion Status",
      "Created At",
      "Submitted At",
      "Approved At",
      "Rejected At",
      "Signed At",
      "Last Action At",
      "Updated At",
      "Admin Notes",
      "Rejection Reason",
      "Rejection Remarks",
      "Correction Remarks",
    ];

    const rows = applications.map((a) => {
      const agreement = !a.financeEnabled
        ? "N/A"
        : (a.agreementStatus?.trim() || "not_generated");
      const docCount = docCountMap.get(a.id) ?? 0;
      const companyType = a.companyType
        ? a.companyType.replaceAll("_", " ")
        : "";

      return [
        a.id,
        a.dealerCode,
        a.companyName,
        companyType,
        a.gstNumber,
        a.panNumber,
        a.cinNumber,
        a.ownerName,
        a.ownerEmail,
        a.ownerPhone,
        a.ownerLandline,
        a.salesManagerName,
        a.salesManagerEmail,
        a.salesManagerMobile,
        formatAddress(a.businessAddress),
        formatAddress(a.registeredAddress),
        a.bankName,
        a.accountNumber,
        a.beneficiaryName,
        a.ifscCode,
        a.onboardingStatus,
        a.reviewStatus,
        a.dealerAccountStatus,
        a.financeEnabled,
        docCount,
        agreement,
        a.agreementLanguage,
        a.stampStatus,
        a.completionStatus,
        a.createdAt,
        a.submittedAt,
        a.approvedAt,
        a.rejectedAt,
        a.signedAt,
        a.lastActionTimestamp,
        a.updatedAt,
        a.adminNotes,
        a.rejectionReason,
        a.rejectionRemarks,
        a.correctionRemarks,
      ];
    });

    const csvBody = [
      headers.map(csvEscape).join(","),
      ...rows.map((r) => r.map(csvEscape).join(",")),
    ].join("\n");

    // UTF-8 BOM so Excel detects encoding correctly for Indian names / ₹ / GST.
    const csv = "﻿" + csvBody;

    const today = new Date().toISOString().slice(0, 10);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="dealer-applications-${today}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("ADMIN DEALER VERIFICATIONS EXPORT ERROR:", error);
    return NextResponse.json(
      { success: false, message: "Failed to export dealer verifications" },
      { status: 500 },
    );
  }
}
