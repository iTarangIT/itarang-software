/**
 * /nbfc/emi-tracker — Automated EMI Tracker (E-NACH auto-debit).
 *
 * Portfolio-wide view of every active loan's EMI status: next due, last paid,
 * repayment progress, DPD, E-NACH mandate status and next auto-debit. The
 * daily crons (run-emi-aging + run-emi-autodebit) keep this current with zero
 * manual entry; the per-loan drawer offers a manual cash record-payment.
 *
 * Server component: one tenant-scoped query (loans + EMI aggregates + mandate)
 * plus a few headline aggregates. Filtering + drill-down are client-side.
 */
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";
import EmiTrackerClient, { type EmiLoanRow } from "./_components/EmiTrackerClient";

export const dynamic = "force-dynamic";

function num(v: unknown): number {
  return v == null ? 0 : Number(v);
}
function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

export default async function EmiTrackerPage() {
  const tenant = await getCurrentTenant();
  await requireNbfcAccess(tenant.id);

  const mode = (process.env.EMI_AUTODEBIT_MODE ?? "simulate").toLowerCase();

  // Main list — loans + EMI aggregates + best mandate, in one query.
  const listResult = await db.execute(sql`
    SELECT
      nl.loan_application_id        AS loan_id,
      nl.vehicleno                  AS vehicleno,
      nl.current_dpd                AS current_dpd,
      COALESCE(l.full_name, '')     AS borrower,
      ls.emi                        AS emi_amount,
      ls.status                     AS loan_status,
      agg.total                     AS total,
      agg.paid_count                AS paid_count,
      agg.overdue_count             AS overdue_count,
      agg.next_due                  AS next_due,
      agg.last_paid                 AS last_paid,
      m.mandate_status              AS mandate_status
    FROM nbfc_loans nl
    JOIN loan_sanctions ls ON ls.id = nl.loan_application_id
    LEFT JOIN leads l ON l.id = ls.lead_id
    LEFT JOIN LATERAL (
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status IN ('paid','paid_late'))::int AS paid_count,
        count(*) FILTER (WHERE status IN ('overdue','missed'))::int AS overdue_count,
        min(due_date) FILTER (WHERE status IN ('scheduled','overdue','missed')) AS next_due,
        max(paid_at) AS last_paid
      FROM emi_schedules es WHERE es.loan_sanction_id = nl.loan_application_id
    ) agg ON true
    LEFT JOIN LATERAL (
      SELECT status AS mandate_status FROM enach_mandates em
      WHERE em.lead_id = ls.lead_id AND em.tenant_id = nl.tenant_id
      ORDER BY CASE WHEN status = 'registered' THEN 0 ELSE 1 END, em.updated_at DESC
      LIMIT 1
    ) m ON true
    WHERE nl.tenant_id = ${tenant.id} AND nl.is_active = true
    ORDER BY agg.overdue_count DESC NULLS LAST, agg.next_due ASC NULLS LAST
    LIMIT 500
  `);

  // db.execute() with the postgres-js driver returns the row array directly —
  // there is NO `.rows` wrapper (that's the node-postgres shape). Same pattern
  // as the NBFC leads page.
  const rawRows = listResult as unknown as Record<string, unknown>[];

  const rows: EmiLoanRow[] = rawRows.map((r) => {
    const overdueCount = num(r.overdue_count);
    const loanStatus = String(r.loan_status ?? "");
    const mandateStatus = str(r.mandate_status);
    const nextDue = str(r.next_due);
    const derivedStatus =
      loanStatus === "closed"
        ? "closed"
        : overdueCount > 0
          ? "overdue"
          : "active";
    return {
      loanId: String(r.loan_id),
      borrower: String(r.borrower ?? "") || "—",
      vehicleno: str(r.vehicleno),
      emiAmount: r.emi_amount == null ? null : num(r.emi_amount),
      nextDue,
      lastPaid: r.last_paid == null ? null : new Date(r.last_paid as string).toISOString(),
      paidCount: num(r.paid_count),
      totalCount: num(r.total),
      overdueCount,
      dpd: num(r.current_dpd),
      mandateStatus,
      derivedStatus,
      nextAutoDebit: mandateStatus === "registered" ? nextDue : null,
    };
  });

  // Headline aggregates (tenant-scoped). EMI status counts come from the
  // schedule; "collected this month" sums actual collection events (so partial
  // payments count) from the attempt ledger.
  const metricsResult = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE es.status IN ('scheduled','overdue') AND es.due_date = CURRENT_DATE)::int AS due_today,
      count(*) FILTER (WHERE es.status IN ('overdue','missed'))::int AS overdue,
      count(*) FILTER (WHERE es.status IN ('paid','paid_late'))::int AS paid_total,
      count(*)::int AS all_total
    FROM emi_schedules es
    JOIN nbfc_loans nl ON nl.loan_application_id = es.loan_sanction_id
    WHERE nl.tenant_id = ${tenant.id} AND nl.is_active = true
  `);
  const collectedResult = await db.execute(sql`
    SELECT COALESCE(sum(amount_paise), 0)::bigint AS collected_paise
    FROM emi_payment_attempts
    WHERE tenant_id = ${tenant.id}
      AND status IN ('succeeded','simulated')
      AND COALESCE(collected_at, created_at) >= date_trunc('month', now())
  `);
  const m = (metricsResult as unknown as Record<string, unknown>[])[0] ?? {};
  const collected = (collectedResult as unknown as Record<string, unknown>[])[0] ?? {};
  const allTotal = num(m.all_total);
  const metrics = {
    activeLoans: rows.length,
    dueToday: num(m.due_today),
    overdue: num(m.overdue),
    collectedMonth: num(collected.collected_paise) / 100,
    collectionRate: allTotal > 0 ? Math.round((num(m.paid_total) / allTotal) * 100) : 0,
  };

  return <EmiTrackerClient rows={rows} metrics={metrics} mode={mode} />;
}
