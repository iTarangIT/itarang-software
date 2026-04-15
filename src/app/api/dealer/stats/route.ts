import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { db } from "@/lib/db";
import {
  users,
  leads,
  inventory,
  loanApplications,
} from "@/lib/db/schema";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { findLatestDealerOnboardingApplication } from "@/lib/dealer-onboarding";

export async function GET() {
  try {
    const supabase = await createClient();

    const {
      data: { user: authUser },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !authUser?.email) {
      return NextResponse.json(
        {
          success: false,
          message: "Unauthorized",
        },
        { status: 401 }
      );
    }

    const matchedUsers = await db
      .select()
      .from(users)
      .where(or(eq(users.id, authUser.id), eq(users.email, authUser.email)))
      .limit(1);

    const appUser = matchedUsers[0];

    if (!appUser) {
      return NextResponse.json(
        {
          success: false,
          message: "User record not found",
        },
        { status: 404 }
      );
    }

    const dealerApp = await findLatestDealerOnboardingApplication({
      authUserId: authUser.id,
      profileUserId: appUser.id,
      email: authUser.email,
    });
    const dealerId = appUser.dealer_id || dealerApp?.dealerCode || null;

    // Safe defaults so dashboard always loads
    let totalLeads = 0;
    let convertedLeads = 0;
    let inventoryCount = 0;
    let loanCount = 0;
    let totalPayments = 0;
    let recentLeads: any[] = [];

    try {
      const totalLeadsResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(leads)
        .where(eq(leads.dealer_id, dealerId || ""));

      totalLeads = Number(totalLeadsResult[0]?.count || 0);
    } catch {}

    try {
      const convertedLeadsResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(leads)
        .where(
          and(
            eq(leads.dealer_id, dealerId || ""),
            eq(leads.lead_status, "converted")
          )
        );

      convertedLeads = Number(convertedLeadsResult[0]?.count || 0);
    } catch {}

    try {
      const inventoryResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(inventory);

      inventoryCount = Number(inventoryResult[0]?.count || 0);
    } catch {}

    try {
      const loanResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(loanApplications)
        .innerJoin(leads, eq(loanApplications.lead_id, leads.id))
        .where(eq(leads.dealer_id, dealerId || ""));

      loanCount = Number(loanResult[0]?.count || 0);
    } catch {}

    try {
      recentLeads = await db
        .select()
        .from(leads)
        .where(eq(leads.dealer_id, dealerId || ""))
        .orderBy(desc(leads.created_at))
        .limit(5);
    } catch {
      recentLeads = [];
    }

    const conversionRate =
      totalLeads > 0 ? Number(((convertedLeads / totalLeads) * 100).toFixed(2)) : 0;

    return NextResponse.json({
      success: true,
      data: {
        dealer: dealerApp
          ? {
              id: dealerApp.id,
              companyName: dealerApp.companyName,
              dealerCode: dealerApp.dealerCode,
              onboardingStatus: dealerApp.onboardingStatus,
              reviewStatus: dealerApp.reviewStatus,
              dealerAccountStatus: dealerApp.dealerAccountStatus,
              approvedAt: dealerApp.approvedAt,
              submittedAt: dealerApp.submittedAt,
              financeEnabled: dealerApp.financeEnabled ?? false,
              isApproved:
                dealerApp.onboardingStatus === "approved" ||
                dealerApp.reviewStatus === "approved" ||
                dealerApp.dealerAccountStatus === "active",
            }
          : null,
        metrics: {
          totalLeads,
          convertedLeads,
          conversionRate,
          commission: 0,
          inventoryCount,
          totalPayments,
          loanCount,
          rewards: 0,
        },
        recentLeads,
      },
    });
  } catch (error: any) {
    console.error("DEALER STATS API ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Failed to load dealer stats",
      },
      { status: 500 }
    );
  }
}
