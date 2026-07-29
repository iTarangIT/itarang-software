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
  zohoInvoices,
  expenseSubmissions,
  nbfc,
  nbfcLspAgreements,
  nbfcLspAgreementSigners,
} from "@/lib/db/schema";

import { eq, gte, lt, sql, and, desc, count, inArray } from "drizzle-orm";
import { requireAuth } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { approvedExpenseInWindow } from "@/lib/dashboard/salesWindow";
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
      // Build the date-window strings directly from local Y/M/D so the
      // boundary lands exactly on the 1st regardless of server timezone
      // (toISOString() can shift a local midnight back a day under +TZ).
      const pad2 = (n: number) => String(n).padStart(2, "0");
      const curYear = now.getFullYear();
      const curMonth = now.getMonth(); // 0-indexed
      const startOfMonthDateStr = `${curYear}-${pad2(curMonth + 1)}-01`;

      const lastMonth = curMonth === 0 ? 11 : curMonth - 1;
      const lastMonthYear = curMonth === 0 ? curYear - 1 : curYear;
      const startOfLastMonthDateStr = `${lastMonthYear}-${pad2(lastMonth + 1)}-01`;
      const startOfLastMonthDate = new Date(lastMonthYear, lastMonth, 1);

      // Financial year (India): starts 1 April. Before April we're still in
      // the FY that began last calendar year.
      const fyStartYear = curMonth >= 3 ? curYear : curYear - 1;
      const fyStartStr = `${fyStartYear}-04-01`;

      // E-219 — the revenue trend (and the ?trendGranularity / ?trendStart /
      // ?trendEnd plumbing that shaped its window) used to be computed here for
      // the "Revenue Performance Trend" chart. That chart is gone: the CEO page
      // now draws revenue against expense and realization from
      // /api/dashboard/ceo/overview, which resolves its window through the
      // shared resolver instead of a private copy. Nothing read the old series.

      // Revenue MTD — sum totals from synced Zoho invoices for current month,
      // excluding only void (drafts are counted as revenue per CEO request).
      const zohoRevenueQ = db
        .select({
          revenue_mtd: sql<string>`COALESCE(SUM(${zohoInvoices.total}), 0)`,
        })
        .from(zohoInvoices)
        .where(
          and(
            gte(zohoInvoices.invoice_date, startOfMonthDateStr),
            sql`(${zohoInvoices.status} IS NULL OR ${zohoInvoices.status} NOT IN ('void'))`,
          ),
        );

      // Void/draft MTD sub-totals — returned separately so the CEO can toggle
      // them into the Revenue card client-side without a refetch.
      const zohoBreakdownQ = db
        .select({
          void_mtd: sql<string>`COALESCE(SUM(${zohoInvoices.total}) FILTER (WHERE ${zohoInvoices.status} = 'void'), 0)`,
          draft_mtd: sql<string>`COALESCE(SUM(${zohoInvoices.total}) FILTER (WHERE ${zohoInvoices.status} = 'draft'), 0)`,
        })
        .from(zohoInvoices)
        .where(gte(zohoInvoices.invoice_date, startOfMonthDateStr));

      // Last-month revenue (same void-only exclusion) for the real MoM badge.
      const zohoRevenueLastMonthQ = db
        .select({
          revenue: sql<string>`COALESCE(SUM(${zohoInvoices.total}), 0)`,
        })
        .from(zohoInvoices)
        .where(
          and(
            gte(zohoInvoices.invoice_date, startOfLastMonthDateStr),
            lt(zohoInvoices.invoice_date, startOfMonthDateStr),
            sql`(${zohoInvoices.status} IS NULL OR ${zohoInvoices.status} NOT IN ('void'))`,
          ),
        );

      // Financial-year-to-date revenue (since 1 April) — base excludes only
      // void (drafts counted); void returned separately so the void filter
      // toggle works in FY mode without a refetch.
      const zohoFyQ = db
        .select({
          base: sql<string>`COALESCE(SUM(${zohoInvoices.total}) FILTER (WHERE ${zohoInvoices.status} IS NULL OR ${zohoInvoices.status} NOT IN ('void')), 0)`,
          void_amt: sql<string>`COALESCE(SUM(${zohoInvoices.total}) FILTER (WHERE ${zohoInvoices.status} = 'void'), 0)`,
          draft_amt: sql<string>`COALESCE(SUM(${zohoInvoices.total}) FILTER (WHERE ${zohoInvoices.status} = 'draft'), 0)`,
        })
        .from(zohoInvoices)
        .where(gte(zohoInvoices.invoice_date, fyStartStr));

      // Inventory value — total capital across all inventory rows.
      const inventoryAggQ = db
        .select({
          inventory_value: sql<string>`COALESCE(SUM(${inventory.final_amount}), 0)`,
        })
        .from(inventory);

      // Outstanding credits — receivables: unpaid invoice balances owed to us.
      // Exclude paid (balance 0), void (cancelled), and draft (unsent — not a
      // real receivable; Zoho's "Total Receivables"/"Unpaid" view excludes them
      // too). Without the draft exclusion this over-reports by the full draft
      // total (e.g. ₹1.08Cr of drafts inflated the figure to ₹1.16Cr vs the
      // true ₹7.89L of overdue balances).
      const outstandingAggQ = db
        .select({
          outstanding: sql<string>`COALESCE(SUM(${zohoInvoices.balance}), 0)`,
        })
        .from(zohoInvoices)
        .where(
          sql`${zohoInvoices.status} IS NULL OR ${zohoInvoices.status} NOT IN ('paid', 'void', 'draft')`,
        );

      // OEM purchases MTD — aggregate from inventory.oem_invoice_date /
      // final_amount. If the inventory table isn't being populated, this
      // tile falls back to ₹0 (see plan: open follow-up to sync the Google
      // Sheet stock ledger).
      const purchasesAggQ = db
        .select({
          purchases_mtd: sql<string>`COALESCE(SUM(${inventory.final_amount}), 0)`,
        })
        .from(inventory)
        .where(gte(inventory.oem_invoice_date, startOfMonthDate));

      // Other business expenses MTD — only approved entries count.
      //
      // E-216 — windowed on COALESCE(expense_date, approved_at::date) rather
      // than approved_at, so an invoice counts in the month it was RAISED, not
      // the month somebody happened to import it. Open-ended (no end bound):
      // month-to-date.
      const approvedThisMonth = approvedExpenseInWindow(startOfMonthDateStr, null);

      const expensesAggQ = db
        .select({
          other_expenses_mtd: sql<string>`COALESCE(SUM(${expenseSubmissions.amount}), 0)`,
        })
        .from(expenseSubmissions)
        .where(approvedThisMonth);

      // E-106 — expense breakdown by department and project tag (MTD).
      const deptExpr = sql<string>`COALESCE(${expenseSubmissions.department}, 'unassigned')`;
      const projectExpr = sql<string>`COALESCE(${expenseSubmissions.project_tag}, 'Unassigned')`;

      const expensesByDepartmentQ = db
        .select({
          department: deptExpr,
          total: sql<string>`COALESCE(SUM(${expenseSubmissions.amount}), 0)`,
        })
        .from(expenseSubmissions)
        .where(approvedThisMonth)
        .groupBy(deptExpr);

      const expensesByProjectQ = db
        .select({
          department: deptExpr,
          project_tag: projectExpr,
          total: sql<string>`COALESCE(SUM(${expenseSubmissions.amount}), 0)`,
        })
        .from(expenseSubmissions)
        .where(approvedThisMonth)
        .groupBy(deptExpr, projectExpr);

      const recentInvoicesQ = db
        .select({
          id: zohoInvoices.id,
          invoice_number: zohoInvoices.invoice_number,
          customer_name: zohoInvoices.customer_name,
          invoice_date: zohoInvoices.invoice_date,
          total: zohoInvoices.total,
          status: zohoInvoices.status,
        })
        .from(zohoInvoices)
        .orderBy(desc(zohoInvoices.invoice_date))
        .limit(5);

      const recentExpensesQ = db
        .select({
          id: expenseSubmissions.id,
          category: expenseSubmissions.category,
          amount: expenseSubmissions.amount,
          approved_at: expenseSubmissions.approved_at,
          submitter_name: users.name,
        })
        .from(expenseSubmissions)
        .leftJoin(users, eq(expenseSubmissions.submitted_by, users.id))
        .where(eq(expenseSubmissions.status, "approved"))
        .orderBy(desc(expenseSubmissions.approved_at))
        .limit(5);

      // E-106 — full AI-tracked expense ledger for the CEO read-only view.
      const aiExpensesQ = db
        .select({
          id: expenseSubmissions.id,
          vendor: expenseSubmissions.vendor,
          amount: expenseSubmissions.amount,
          description: expenseSubmissions.description,
          department: expenseSubmissions.department,
          // E-218 — the ledger shows and filters on the spend bucket.
          bucket: expenseSubmissions.bucket,
          project_tag: expenseSubmissions.project_tag,
          expense_date: expenseSubmissions.expense_date,
          bill_url: expenseSubmissions.bill_url,
          created_at: expenseSubmissions.created_at,
          submitter_name: users.name,
        })
        .from(expenseSubmissions)
        .leftJoin(users, eq(expenseSubmissions.submitted_by, users.id))
        .where(eq(expenseSubmissions.source, "ai"))
        .orderBy(desc(expenseSubmissions.created_at))
        .limit(200);

        // conversion rate
      const conversionResultQ = db
        .select({
          total_leads: sql<number>`COUNT(*)`,
          conversions: sql<number>`COUNT(*) FILTER (WHERE current_status = 'qualified')`,
        })
        .from(dealerLeads)
        .where(gte(dealerLeads.created_at, startOfMonthDate));

      // Last-month conversion rate — for the real MoM change badge.
      const conversionLastMonthQ = db
        .select({
          total_leads: sql<number>`COUNT(*)`,
          conversions: sql<number>`COUNT(*) FILTER (WHERE current_status = 'qualified')`,
        })
        .from(dealerLeads)
        .where(
          and(
            gte(dealerLeads.created_at, startOfLastMonthDate),
            lt(dealerLeads.created_at, startOfMonthDate),
          ),
        );

      // Procurement overview — pending approvals + active (in-flight) value.
      const procurementAggQ = db
        .select({
          pending_approvals: sql<number>`COUNT(*) FILTER (WHERE ${provisions.status} = 'pending')`,
          active_value: sql<string>`COALESCE(SUM(${provisions.amount}) FILTER (WHERE ${provisions.status} NOT IN ('cancelled', 'completed')), 0)`,
        })
        .from(provisions);

      // Top sales managers — ranked by qualified conversions on owned leads.
      const topManagerRowsQ = db
        .select({
          id: users.id,
          name: users.name,
          total: sql<number>`COUNT(${dealerLeads.id})`,
          qualified: sql<number>`COUNT(*) FILTER (WHERE ${dealerLeads.current_status} = 'qualified')`,
        })
        .from(leadAssignments)
        .innerJoin(users, eq(users.id, leadAssignments.lead_owner))
        .innerJoin(dealerLeads, eq(dealerLeads.id, leadAssignments.lead_id))
        .where(eq(users.role, "sales_manager"))
        .groupBy(users.id, users.name)
        .orderBy(
          desc(
            sql`COUNT(*) FILTER (WHERE ${dealerLeads.current_status} = 'qualified')`,
          ),
        )
        .limit(3);

      // NBFC LSP agreements currently in flight — Digio has the auto-filled
      // PDF and signers are working through the sequence. Surfaces on the CEO
      // landing card so Sanchit sees signing progress without navigating into
      // every NBFC's review page.
      const inFlightAgreementsQ = db
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

      // Signer counts depend on the agreements query — chained off it so the
      // pair still runs inside the same Promise.all pass as everything else.
      // Wrapped in a real Promise first: Drizzle builders re-execute on every
      // .then(), and this one is consumed twice (here and in Promise.all).
      const inFlightAgreementsP = Promise.resolve(inFlightAgreementsQ);
      const signerCountsQ = inFlightAgreementsP.then((agreements) => {
        const agreementIds = agreements.map((a) => a.agreementId);
        return agreementIds.length
          ? db
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
      });

      // All CEO-dashboard queries fire together — they only depend on the
      // date strings computed above, and the pooled connection (max 5)
      // queues the overflow, so wall-clock is bounded by the slowest few
      // round-trips instead of the sum of all ~20.
      const [
        [zohoRevenue],
        [zohoBreakdown],
        [zohoRevenueLastMonth],
        [zohoFy],
        [inventoryAgg],
        [outstandingAgg],
        [purchasesAgg],
        [expensesAgg],
        expensesByDepartment,
        expensesByProject,
        recentInvoices,
        recentExpenses,
        aiExpenses,
        [conversionResult],
        [conversionLastMonth],
        [procurementAgg],
        topManagerRows,
        inFlightAgreements,
        signerCounts,
      ] = await Promise.all([
        zohoRevenueQ,
        zohoBreakdownQ,
        zohoRevenueLastMonthQ,
        zohoFyQ,
        inventoryAggQ,
        outstandingAggQ,
        purchasesAggQ,
        expensesAggQ,
        expensesByDepartmentQ,
        expensesByProjectQ,
        recentInvoicesQ,
        recentExpensesQ,
        aiExpensesQ,
        conversionResultQ,
        conversionLastMonthQ,
        procurementAggQ,
        topManagerRowsQ,
        inFlightAgreementsP,
        signerCountsQ,
      ]);

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

      const revenueMtd = Number(zohoRevenue?.revenue_mtd || 0);
      const revenueLastMonth = Number(zohoRevenueLastMonth?.revenue || 0);
      const revenueChange =
        revenueLastMonth > 0
          ? ((revenueMtd - revenueLastMonth) / revenueLastMonth) * 100
          : null;

      const conversionRate = conversionResult?.total_leads
        ? (Number(conversionResult.conversions) /
            Number(conversionResult.total_leads)) *
          100
        : 0;
      const conversionRateLastMonth = conversionLastMonth?.total_leads
        ? (Number(conversionLastMonth.conversions) /
            Number(conversionLastMonth.total_leads)) *
          100
        : null;
      // Conversion is a percentage already; report the change in percentage points.
      const conversionChange =
        conversionRateLastMonth !== null
          ? conversionRate - conversionRateLastMonth
          : null;

      const topSalesManagers = topManagerRows.map((r) => {
        const total = Number(r.total) || 0;
        const qualified = Number(r.qualified) || 0;
        const pct = total > 0 ? Math.round((qualified / total) * 100) : 0;
        return {
          id: r.id,
          name: r.name,
          // `users` has no region column — surface lead volume instead.
          region: `${total} lead${total === 1 ? "" : "s"}`,
          conversion: `${pct}%`,
        };
      });

      return successResponse({
        revenue: revenueMtd,
        revenue_mtd: revenueMtd,
        revenue_void_mtd: Number(zohoBreakdown?.void_mtd || 0),
        revenue_draft_mtd: Number(zohoBreakdown?.draft_mtd || 0),
        revenue_fytd: Number(zohoFy?.base || 0),
        revenue_void_fytd: Number(zohoFy?.void_amt || 0),
        revenue_draft_fytd: Number(zohoFy?.draft_amt || 0),
        fyStartLabel: `1 Apr ${fyStartYear}`,
        revenueChange,
        purchases_mtd: Number(purchasesAgg?.purchases_mtd || 0),
        other_expenses_mtd: Number(expensesAgg?.other_expenses_mtd || 0),
        expenses_by_department: expensesByDepartment.map((r) => ({
          department: r.department,
          total: Number(r.total),
        })),
        expenses_by_project: expensesByProject.map((r) => ({
          department: r.department,
          project_tag: r.project_tag,
          total: Number(r.total),
        })),
        ai_expenses: aiExpenses,
        inventoryValue: Number(inventoryAgg?.inventory_value || 0),
        outstandingCredits: Number(outstandingAgg?.outstanding || 0),
        recent_invoices: recentInvoices,
        recent_expenses: recentExpenses,
        conversionRate,
        conversionChange,
        leadsTotal: Number(conversionResult?.total_leads || 0),
        leadsConverted: Number(conversionResult?.conversions || 0),
        procurementStats: {
          pendingApprovals: Number(procurementAgg?.pending_approvals || 0),
          activeValue: Number(procurementAgg?.active_value || 0),
        },
        topSalesManagers,
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
      const [[revenue], [pipeline]] = await Promise.all([
        db
          .select({
            total: sql<number>`COALESCE(SUM(total_amount), 0)`,
          })
          .from(orders),
        db
          .select({
            total: sql<number>`COALESCE(SUM(total_payable), 0)`,
          })
          .from(deals)
          .where(sql`deal_status NOT IN ('converted', 'rejected')`),
      ]);

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
