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
  nbfc,
  nbfcLspAgreements,
  nbfcLspAgreementSigners,
} from "@/lib/db/schema";

import { eq, gte, sql, and, desc, count, inArray } from "drizzle-orm";
import { requireAuth } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { LSP_IN_FLIGHT_STATUSES } from "@/components/admin/nbfc/lspStatusTone";

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

      // NBFC LSP agreements currently in flight — Digio has the auto-filled
      // PDF and signers are working through the sequence. Surfaces on the CEO
      // landing card so Sanchit sees signing progress without navigating into
      // every NBFC's review page.
      const inFlightAgreements = await db
        .select({
          nbfcId: nbfc.id,
          nbfcShortId: nbfc.nbfc_id,
          legalName: nbfc.legal_name,
          agreementId: nbfcLspAgreements.id,
          agreementStatus: nbfcLspAgreements.agreement_status,
          initiatedAt: nbfcLspAgreements.initiated_at,
          createdAt: nbfcLspAgreements.created_at,
        })
        .from(nbfcLspAgreements)
        .innerJoin(nbfc, eq(nbfc.id, nbfcLspAgreements.nbfc_id))
        .where(
          inArray(
            nbfcLspAgreements.agreement_status,
            LSP_IN_FLIGHT_STATUSES as unknown as string[],
          ),
        )
        .orderBy(
          desc(nbfcLspAgreements.initiated_at),
          desc(nbfcLspAgreements.created_at),
        )
        .limit(10);

      const agreementIds = inFlightAgreements.map((a) => a.agreementId);
      const signerCounts = agreementIds.length
        ? await db
            .select({
              agreementId: nbfcLspAgreementSigners.nbfc_lsp_agreement_id,
              total: sql<number>`COUNT(*)`,
              signed: sql<number>`COUNT(*) FILTER (WHERE ${nbfcLspAgreementSigners.signing_status} = 'signed')`,
            })
            .from(nbfcLspAgreementSigners)
            .where(
              inArray(
                nbfcLspAgreementSigners.nbfc_lsp_agreement_id,
                agreementIds,
              ),
            )
            .groupBy(nbfcLspAgreementSigners.nbfc_lsp_agreement_id)
        : [];
      const countsByAgreement = new Map<
        number,
        { total: number; signed: number }
      >();
      for (const r of signerCounts) {
        countsByAgreement.set(r.agreementId, {
          total: Number(r.total),
          signed: Number(r.signed),
        });
      }
      const nbfcSigningQueue = inFlightAgreements.map((a) => {
        const counts = countsByAgreement.get(a.agreementId) ?? {
          total: 0,
          signed: 0,
        };
        return {
          nbfcId: a.nbfcId,
          nbfcShortId: a.nbfcShortId,
          legalName: a.legalName,
          agreementStatus: a.agreementStatus,
          signed: counts.signed,
          total: counts.total,
        };
      });

      return successResponse({
        revenue: Number(revenueResult?.revenue || 0),
        conversionRate: conversionResult?.total_leads
          ? (Number(conversionResult.conversions) /
              Number(conversionResult.total_leads)) *
            100
          : 0,
        nbfcSigningQueue,
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
