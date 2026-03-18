import { createClient } from "@/lib/supabase/server";
import { withErrorHandler, successResponse, errorResponse } from "@/lib/api-utils";
import { db } from "@/lib/db/index";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";

type OrderAmountRow = {
  total_amount: string | number | null;
};

export const GET = withErrorHandler(async (_req: Request) => {
  const supabase = await createClient();

  // 1. Authenticate
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return errorResponse("Unauthorized", 401);

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("role, dealer_id, name, email")
    .eq("id", user.id)
    .single();

  if (profileError || !profile) {
    return errorResponse("Dealer profile not found", 404);
  }

  if (profile.role !== "dealer") {
    return errorResponse("Access denied", 403);
  }

  // 2. Get latest onboarding application for this dealer user
  const onboardingRows = await db
    .select()
    .from(dealerOnboardingApplications)
    .where(eq(dealerOnboardingApplications.dealerUserId, user.id))
    .orderBy(desc(dealerOnboardingApplications.createdAt));

  const onboarding = onboardingRows[0] || null;

  const isApproved =
    onboarding?.reviewStatus === "approved" &&
    onboarding?.onboardingStatus === "approved" &&
    onboarding?.dealerAccountStatus === "active";

  // 3. Query KPI data in parallel
  const dealerAccountId = profile.dealer_id || null;

  const [
    totalLeadsResult,
    convertedLeadsResult,
    recentLeadsResult,
    inventoryCountResult,
    ordersResult,
    loanCountResult,
  ] = await Promise.all([
    dealerAccountId
      ? supabase
          .from("leads")
          .select("*", { count: "exact", head: true })
          .eq("dealer_id", dealerAccountId)
      : Promise.resolve({ count: 0 }),

    dealerAccountId
      ? supabase
          .from("leads")
          .select("*", { count: "exact", head: true })
          .eq("dealer_id", dealerAccountId)
          .eq("lead_status", "converted")
      : Promise.resolve({ count: 0 }),

    dealerAccountId
      ? supabase
          .from("leads")
          .select("*")
          .eq("dealer_id", dealerAccountId)
          .order("created_at", { ascending: false })
          .limit(5)
      : Promise.resolve({ data: [] }),

    supabase
      .from("inventory")
      .select("*", { count: "exact", head: true })
      .eq("created_by", user.id),

    dealerAccountId
      ? supabase
          .from("orders")
          .select("total_amount")
          .eq("account_id", dealerAccountId)
      : Promise.resolve({ data: [] as OrderAmountRow[] }),

    supabase
      .from("loan_applications")
      .select("*", { count: "exact", head: true })
      .eq("created_by", user.id),
  ]);

  const totalLeads = totalLeadsResult.count || 0;
  const convertedLeads = convertedLeadsResult.count || 0;
  const recentLeads = recentLeadsResult.data || [];
  const inventoryCount = inventoryCountResult.count || 0;
  const orders = (ordersResult.data || []) as OrderAmountRow[];
  const loanCount = loanCountResult.count || 0;

  const conversionRate =
    totalLeads > 0 ? Math.round((convertedLeads / totalLeads) * 100) : 0;

  const totalPayments = orders.reduce((sum: number, order: OrderAmountRow) => {
    return sum + Number(order.total_amount || 0);
  }, 0);

  return successResponse({
    dealer: {
      id: onboarding?.id || null,
      companyName: onboarding?.companyName || profile.name || "Dealer",
      dealerCode: onboarding?.dealerCode || profile.dealer_id || null,
      onboardingStatus: onboarding?.onboardingStatus || "draft",
      reviewStatus: onboarding?.reviewStatus || "pending",
      dealerAccountStatus: onboarding?.dealerAccountStatus || "inactive",
      approvedAt: onboarding?.approvedAt || null,
      submittedAt: onboarding?.submittedAt || null,
      financeEnabled: onboarding?.financeEnabled || false,
      isApproved,
    },
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
  });
});