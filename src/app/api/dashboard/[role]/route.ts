import { db } from "@/lib/db";
import {
  users,
  dealerLeads,
  leadAssignments,
  deals,
  inventory,
  orders,
  oemInventoryForPDI,
  pdiRecords,
  accounts,
  provisions,
} from "@/lib/db/schema";

import { eq, gte, sql, and, desc, count } from "drizzle-orm";
import { requireAuth } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";

export const GET = withErrorHandler(
  async (req: Request, { params }: { params: Promise<{ role: string }> }) => {
    const user = await requireAuth();
    const { role } = await params;

    if (user.role !== role && user.role !== "ceo") {
      throw new Error("Forbidden");
    }

    const rows = (res: any) => (Array.isArray(res) ? res : (res?.rows ?? []));

    const now = new Date();
    const startOfMonthDate = new Date(now.getFullYear(), now.getMonth(), 1);

    // ================= CEO =================
    if (role === "ceo") {
      const [revenueResult] = await db
        .select({
          revenue: sql<number>`COALESCE(SUM(total_payable), 0)`,
        })
        .from(deals)
        .where(
          and(
            eq(deals.deal_status, "converted"),
            gte(deals.created_at, startOfMonthDate),
          ),
        );

      const [conversionResult] = await db
        .select({
          total_leads: sql<number>`COUNT(*)`,
          conversions: sql<number>`COUNT(*) FILTER (WHERE current_status = 'qualified')`,
        })
        .from(dealerLeads)
        .where(gte(dealerLeads.created_at, startOfMonthDate));

      return successResponse({
        revenue: Number(revenueResult?.revenue || 0),
        conversionRate: conversionResult?.total_leads
          ? (Number(conversionResult.conversions) /
              Number(conversionResult.total_leads)) *
            100
          : 0,
        lastUpdated: new Date().toISOString(),
      });
    }

    // ================= SALES MANAGER =================
    if (role === "sales_manager") {
      const [leadStats] = await db
        .select({
          activeLeads: count(),
        })
        .from(dealerLeads)
        .innerJoin(leadAssignments, eq(dealerLeads.id, leadAssignments.lead_id))
        .where(eq(leadAssignments.lead_owner, user.id));

      return successResponse({
        activeLeads: Number(leadStats?.activeLeads || 0),
        lastUpdated: new Date().toISOString(),
      });
    }

    // ================= BUSINESS HEAD =================
    if (role === "business_head") {
      const [stats] = await db
        .select({
          activeLeads: count(),
          conversions: sql<number>`COUNT(*) FILTER (WHERE current_status = 'qualified')`,
        })
        .from(dealerLeads);

      return successResponse({
        activeLeads: stats?.activeLeads || 0,
        conversionRate: stats?.activeLeads
          ? ((stats.conversions / stats.activeLeads) * 100).toFixed(1)
          : 0,
        lastUpdated: new Date().toISOString(),
      });
    }

    // ================= SALES HEAD =================
    if (role === "sales_head") {
      const [revenue] = await db
        .select({
          total: sql<number>`COALESCE(SUM(total_amount), 0)`,
        })
        .from(orders);

      const [pipeline] = await db
        .select({
          total: sql<number>`COALESCE(SUM(total_payable), 0)`,
        })
        .from(deals)
        .where(sql`deal_status NOT IN ('converted', 'rejected')`);

      return successResponse({
        pipelineRevenue: pipeline?.total || 0,
        totalRevenue: revenue?.total || 0,
        lastUpdated: new Date().toISOString(),
      });
    }

    // ================= SALES EXECUTIVE =================
    if (role === "sales_executive") {
      const [leadStats] = await db
        .select({
          activeLeads: count(),
        })
        .from(dealerLeads)
        .innerJoin(leadAssignments, eq(dealerLeads.id, leadAssignments.lead_id))
        .where(eq(leadAssignments.lead_owner, user.id));

      return successResponse({
        activeLeads: Number(leadStats?.activeLeads || 0),
        lastUpdated: new Date().toISOString(),
      });
    }

    // ================= DEALER =================
    if (role === "dealer") {
      const [leadStats] = await db
        .select({
          totalLeads: count(),
        })
        .from(dealerLeads)
        .where(eq(dealerLeads.dealer_id, user.dealer_id || ""));

      return successResponse({
        totalLeads: Number(leadStats?.totalLeads || 0),
        lastUpdated: new Date().toISOString(),
      });
    }

    return successResponse({
      message: `Dashboard for role ${role} is under construction`,
    });
  },
);
