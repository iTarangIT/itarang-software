/**
 * Pure portfolio-summary computation for E-026 (BRD §6.1.3).
 *
 * Decoupled from the HTTP / auth layer so it can be unit-tested without
 * spinning up a Next.js server. The route handler in
 * src/app/api/nbfc/portfolio/summary/route.ts is a thin wrapper around this.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  borrowerRiskScores,
  loanSanctions,
  nbfcRecoveryPipeline,
} from "@/lib/db/schema";

export interface PortfolioSummary {
  total_active_loans: number;
  portfolio_value: number;
  avg_emi: number;
  disbursement_this_month: number;
  delinquency_rate: number;
  avg_portfolio_cds: number;
  recovery_value_locked: number;
  computed_at: string;
}

export function startOfCurrentMonthIST(): Date {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffsetMs);
  const startIst = new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1, 0, 0, 0),
  );
  return new Date(startIst.getTime() - istOffsetMs);
}

export async function computePortfolioSummary(tenantId: string): Promise<PortfolioSummary> {
  // Active loans: status='disbursed' AND closed_at IS NULL, scoped to tenant.
  const activeLoans = await db
    .select({
      id: loanSanctions.id,
      loan_amount: loanSanctions.loan_amount,
      emi: loanSanctions.emi,
    })
    .from(loanSanctions)
    .where(
      and(
        eq(loanSanctions.nbfc_id, tenantId),
        eq(loanSanctions.status, "disbursed"),
        isNull(loanSanctions.closed_at),
      ),
    );

  const total_active_loans = activeLoans.length;
  const portfolio_value = activeLoans.reduce(
    (acc, r) => acc + (r.loan_amount != null ? Number(r.loan_amount) : 0),
    0,
  );

  // Avg EMI (BRD §6.1.2) — mean of loan_sanctions.emi across the active book.
  // Skip rows where emi is null so a row with missing EMI doesn't drag the mean
  // toward zero.
  const emiValues = activeLoans
    .map((r) => (r.emi != null ? Number(r.emi) : null))
    .filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
  const avg_emi =
    emiValues.length === 0
      ? 0
      : Math.round(emiValues.reduce((a, b) => a + b, 0) / emiValues.length);

  // Disbursement this month (IST calendar month).
  const monthStart = startOfCurrentMonthIST();
  const disbursementRows = await db
    .select({ disbursement_amount: loanSanctions.disbursement_amount })
    .from(loanSanctions)
    .where(
      and(
        eq(loanSanctions.nbfc_id, tenantId),
        sql`${loanSanctions.disbursed_at} >= ${monthStart.toISOString()}`,
      ),
    );
  const disbursement_this_month = disbursementRows.reduce(
    (acc, r) =>
      acc + (r.disbursement_amount != null ? Number(r.disbursement_amount) : 0),
    0,
  );

  // Delinquency rate — until a per-EMI table exists, derive from nbfc_loans.current_dpd
  // for the same tenant. Tenant-scoped: nbfc_loans.tenant_id = tenantId.
  let overdue_count = 0;
  if (total_active_loans > 0) {
    const overdueRows = await db.execute<{ overdue: number }>(sql`
      SELECT COUNT(*)::int AS overdue
      FROM nbfc_loans
      WHERE tenant_id = ${tenantId}::uuid
        AND current_dpd > 30
        AND is_active = true
    `);
    const arr = overdueRows as unknown as Array<{ overdue: number }>;
    overdue_count = arr[0]?.overdue ?? 0;
  }
  const delinquency_rate =
    total_active_loans === 0
      ? 0
      : Math.round((overdue_count / total_active_loans) * 100 * 100) / 100;

  // Avg portfolio CDS — average of cds_score across rows for this tenant.
  const cdsRows = await db
    .select({ cds_score: borrowerRiskScores.cds_score })
    .from(borrowerRiskScores)
    .where(eq(borrowerRiskScores.tenant_id, tenantId));
  const cdsValues = cdsRows
    .map((r) => (r.cds_score != null ? Number(r.cds_score) : null))
    .filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
  const avg_portfolio_cds =
    cdsValues.length === 0
      ? 0
      : Math.round(
          (cdsValues.reduce((a, b) => a + b, 0) / cdsValues.length) * 100,
        ) / 100;

  // Recovery value locked — non-'resold' rows for this tenant.
  const recoveryRows = await db
    .select({
      estimated_recovery_value: nbfcRecoveryPipeline.estimated_recovery_value,
    })
    .from(nbfcRecoveryPipeline)
    .where(
      and(
        eq(nbfcRecoveryPipeline.tenant_id, tenantId),
        sql`${nbfcRecoveryPipeline.stage} <> 'resold'`,
      ),
    );
  const recovery_value_locked = recoveryRows.reduce(
    (acc, r) =>
      acc +
      (r.estimated_recovery_value != null
        ? Number(r.estimated_recovery_value)
        : 0),
    0,
  );

  return {
    total_active_loans,
    portfolio_value,
    avg_emi,
    disbursement_this_month,
    delinquency_rate,
    avg_portfolio_cds,
    recovery_value_locked,
    computed_at: new Date().toISOString(),
  };
}
