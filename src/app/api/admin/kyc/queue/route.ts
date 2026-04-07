import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gte, lte, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  adminVerificationQueue,
  dealerLeads,
  kycVerificationMetadata,
} from "@/lib/db/schema";
import {
  ADMIN_KYC_SUMMARY_STATUSES,
  calculateQueuePriority,
  formatSlaAge,
  requireAdminAppUser,
} from "@/lib/kyc/admin-workflow";

function parseOptionalDate(value: string | null, endOfDay = false): Date | null {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  if (endOfDay) {
    date.setHours(23, 59, 59, 999);
  } else {
    date.setHours(0, 0, 0, 0);
  }

  return date;
}

export async function GET(req: NextRequest) {
  try {
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status")?.trim() || "";
    const dealer = searchParams.get("dealer")?.trim().toLowerCase() || "";
    const city = searchParams.get("city")?.trim().toLowerCase() || "";
    const priority = searchParams.get("priority")?.trim().toLowerCase() || "";
    const dateFrom = parseOptionalDate(searchParams.get("dateFrom"));
    const dateTo = parseOptionalDate(searchParams.get("dateTo"), true);

    const whereConditions: SQL[] = [];

    if (status) {
      whereConditions.push(eq(adminVerificationQueue.status, status));
    }

    if (dateFrom) {
      whereConditions.push(gte(adminVerificationQueue.created_at, dateFrom));
    }

    if (dateTo) {
      whereConditions.push(lte(adminVerificationQueue.created_at, dateTo));
    }

    const queueRows = await db
      .select({
        id: adminVerificationQueue.id,
        lead_id: adminVerificationQueue.lead_id,
        queue_type: adminVerificationQueue.queue_type,
        priority: adminVerificationQueue.priority,
        status: adminVerificationQueue.status,
        assigned_to: adminVerificationQueue.assigned_to,
        submitted_at: adminVerificationQueue.submitted_at,
        created_at: adminVerificationQueue.created_at,
        updated_at: adminVerificationQueue.updated_at,
        customerName: dealerLeads.dealer_name,
        contactNumber: dealerLeads.phone,
        dealerName: dealerLeads.shop_name,
        cityName: dealerLeads.location,
        consentVerified: kycVerificationMetadata.consent_verified,
        couponCode: kycVerificationMetadata.coupon_code,
        couponStatus: kycVerificationMetadata.coupon_status,
        documentsCount: kycVerificationMetadata.documents_count,
        caseType: kycVerificationMetadata.case_type,
      })
      .from(adminVerificationQueue)
      .innerJoin(dealerLeads, eq(adminVerificationQueue.lead_id, dealerLeads.id))
      .leftJoin(
        kycVerificationMetadata,
        eq(adminVerificationQueue.lead_id, kycVerificationMetadata.lead_id),
      )
      .where(whereConditions.length > 0 ? and(...whereConditions) : undefined)
      .orderBy(desc(adminVerificationQueue.created_at));

    const filteredRows = queueRows.filter((row) => {
      const dealerMatches = dealer
        ? (row.dealerName ?? "").toLowerCase().includes(dealer)
        : true;
      const cityMatches = city
        ? (row.cityName ?? "").toLowerCase().includes(city)
        : true;
      const effectivePriority = calculateQueuePriority({
        createdAt: row.created_at ?? new Date(),
        status: row.status,
      });
      const priorityMatches = priority ? effectivePriority === priority : true;

      return dealerMatches && cityMatches && priorityMatches;
    });

    const summary = ADMIN_KYC_SUMMARY_STATUSES.reduce(
      (acc, queueStatus) => {
        acc[queueStatus] = filteredRows.filter(
          (row) => row.status === queueStatus,
        ).length;
        return acc;
      },
      {} as Record<(typeof ADMIN_KYC_SUMMARY_STATUSES)[number], number>,
    );

    const items = filteredRows.map((row, index) => {
      const effectivePriority = calculateQueuePriority({
        createdAt: row.created_at ?? new Date(),
        status: row.status,
      });

      return {
        queueId: row.id,
        leadId: row.lead_id,
        customer: row.customerName ?? "Unknown",
        contactNumber: row.contactNumber ?? null,
        dealer: row.dealerName ?? "Unknown Dealer",
        city: row.cityName ?? null,
        submittedDate: row.submitted_at ?? row.created_at,
        consentStatus: row.consentVerified ? "verified" : "pending",
        couponCode: row.couponCode ?? null,
        couponStatus: row.couponStatus ?? null,
        documentsCount: row.documentsCount ?? 0,
        caseType: row.caseType ?? null,
        status: row.status,
        priority: effectivePriority,
        sla: formatSlaAge(row.created_at ?? new Date()),
        queuePosition: index + 1,
        action: ["approved", "rejected"].includes(row.status) ? "view" : "review",
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        summary: {
          pending: summary.pending_itarang_verification ?? 0,
          inProgress: summary.in_progress ?? 0,
          requestedCorrection: summary.requested_correction ?? 0,
          rejected: summary.rejected ?? 0,
          approved: summary.approved ?? 0,
        },
        items,
      },
    });
  } catch (error) {
    console.error("[Admin KYC Queue] Error:", error);

    const message =
      error instanceof Error ? error.message : "Failed to fetch admin queue";

    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
