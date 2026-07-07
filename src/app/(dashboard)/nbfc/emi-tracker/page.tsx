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
      m.mandate_status              AS mandate_status,
      -- E-181 per-loan display overrides (NULL = show computed value)
      ov.borrower                   AS ov_borrower,
      ov.vehicleno                  AS ov_vehicleno,
      ov.emi                        AS ov_emi,
      ov.next_due                   AS ov_next_due,
      ov.last_paid                  AS ov_last_paid,
      ov.progress_paid              AS ov_progress_paid,
      ov.progress_total             AS ov_progress_total,
      ov.status                     AS ov_status,
      ov.dpd                        AS ov_dpd,
      ov.mandate                    AS ov_mandate,
      ov.next_auto_debit            AS ov_next_auto_debit,
      ov.financier                  AS ov_financier
    FROM nbfc_loans nl
    JOIN loan_sanctions ls ON ls.id = nl.loan_application_id
    LEFT JOIN leads l ON l.id = ls.lead_id
    LEFT JOIN nbfc_emi_tracker_overrides ov
      ON ov.tenant_id = nl.tenant_id
     AND ov.loan_application_id = nl.loan_application_id
    LEFT JOIN LATERAL (
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status IN ('paid','paid_late'))::int AS paid_count,
        count(*) FILTER (WHERE status IN ('overdue','missed'))::int AS overdue_count,
        -- Next due = the soonest UPCOMING unpaid installment (due today or
        -- later) that still has a balance owed. Past-due arrears are surfaced
        -- via the Overdue status + DPD columns, not here — this column shows
        -- the next payment the borrower has coming up, never a past date.
        -- An installment with nothing outstanding (amount 0, or already
        -- covered by amount_paid) is not "due" — skip it so a ₹0 / waived
        -- missed EMI never surfaces. A loan whose entire term has lapsed into
        -- arrears (no future installment) has no next due → NULL → shown as "—".
        min(due_date) FILTER (
          WHERE status IN ('scheduled','overdue','missed')
            AND COALESCE(amount, 0) - COALESCE(amount_paid, 0) > 0
            AND due_date >= CURRENT_DATE
        ) AS next_due,
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

  // ISO/date string → 'YYYY-MM-DD' (date columns already come back that way).
  const dateStr = (v: unknown): string | null =>
    v == null ? null : String(v).slice(0, 10);

  const rows: EmiLoanRow[] = rawRows.map((r) => {
    const overdueCount = num(r.overdue_count);
    const loanStatus = String(r.loan_status ?? "");

    // ---- Computed (pre-override) values ------------------------------------
    const cBorrower = String(r.borrower ?? "") || "—";
    const cVehicleno = str(r.vehicleno);
    const cEmi = r.emi_amount == null ? null : num(r.emi_amount);
    const cNextDue = dateStr(r.next_due);
    const cLastPaid = r.last_paid == null ? null : new Date(r.last_paid as string).toISOString();
    const cPaidCount = num(r.paid_count);
    const cTotal = num(r.total);
    const cDpd = num(r.current_dpd);
    const cMandate = str(r.mandate_status);
    const cDerived: "active" | "overdue" | "closed" =
      loanStatus === "closed" ? "closed" : overdueCount > 0 ? "overdue" : "active";
    const cNextAutoDebit = cMandate === "registered" ? cNextDue : null;

    const computed = {
      borrower: cBorrower,
      vehicleno: cVehicleno,
      emiAmount: cEmi,
      nextDue: cNextDue,
      lastPaid: cLastPaid,
      paidCount: cPaidCount,
      totalCount: cTotal,
      derivedStatus: cDerived,
      dpd: cDpd,
      mandateStatus: cMandate,
      nextAutoDebit: cNextAutoDebit,
      // Financier has no canonical source to compute from — override-only.
      financier: null,
    };

    // ---- Effective (override → computed) values ----------------------------
    const oStatus = str(r.ov_status) as "active" | "overdue" | "closed" | null;
    const eMandate = r.ov_mandate != null ? str(r.ov_mandate) : cMandate;
    const eNextDue = r.ov_next_due != null ? dateStr(r.ov_next_due) : cNextDue;
    const eNextAutoDebit =
      r.ov_next_auto_debit != null
        ? dateStr(r.ov_next_auto_debit)
        : eMandate === "registered"
          ? eNextDue
          : null;

    return {
      loanId: String(r.loan_id),
      borrower: r.ov_borrower != null ? String(r.ov_borrower) : cBorrower,
      vehicleno: r.ov_vehicleno != null ? String(r.ov_vehicleno) : cVehicleno,
      emiAmount: r.ov_emi != null ? num(r.ov_emi) : cEmi,
      nextDue: eNextDue,
      lastPaid: r.ov_last_paid != null ? dateStr(r.ov_last_paid) : cLastPaid,
      paidCount: r.ov_progress_paid != null ? num(r.ov_progress_paid) : cPaidCount,
      totalCount: r.ov_progress_total != null ? num(r.ov_progress_total) : cTotal,
      overdueCount,
      dpd: r.ov_dpd != null ? num(r.ov_dpd) : cDpd,
      mandateStatus: eMandate,
      derivedStatus: oStatus ?? cDerived,
      nextAutoDebit: eNextAutoDebit,
      financier: str(r.ov_financier),
      computed,
    };
  });

  // ── Standalone tracker entries (E-183) ────────────────────────────────────
  // Bulk-upload rows that had no matching loan and were force-imported as
  // display-only records. They live entirely in the override table (no loan /
  // schedule / mandate), so every value is read verbatim — no computed fallback.
  const standaloneResult = await db.execute(sql`
    SELECT
      ov.id, ov.borrower, ov.vehicleno, ov.emi, ov.next_due, ov.last_paid,
      ov.progress_paid, ov.progress_total, ov.status, ov.dpd, ov.mandate,
      ov.next_auto_debit, ov.financier
    FROM nbfc_emi_tracker_overrides ov
    WHERE ov.tenant_id = ${tenant.id} AND ov.is_standalone = true
    ORDER BY ov.updated_at DESC
    LIMIT 500
  `);
  const standaloneRows: EmiLoanRow[] = (standaloneResult as unknown as Record<string, unknown>[]).map((r) => {
    const borrower = r.borrower != null ? String(r.borrower) : "—";
    const vehicleno = str(r.vehicleno);
    const emiAmount = r.emi == null ? null : num(r.emi);
    const nextDue = dateStr(r.next_due);
    const lastPaid = dateStr(r.last_paid);
    const paidCount = num(r.progress_paid);
    const totalCount = num(r.progress_total);
    const dpd = num(r.dpd);
    const mandateStatus = str(r.mandate);
    const derivedStatus = (str(r.status) as "active" | "overdue" | "closed" | null) ?? "active";
    const nextAutoDebit = dateStr(r.next_auto_debit);
    const financier = str(r.financier);
    return {
      loanId: `standalone:${String(r.id)}`,
      isStandalone: true,
      overrideId: String(r.id),
      borrower,
      vehicleno,
      emiAmount,
      nextDue,
      lastPaid,
      paidCount,
      totalCount,
      overdueCount: derivedStatus === "overdue" ? 1 : 0,
      dpd,
      mandateStatus,
      derivedStatus,
      nextAutoDebit,
      financier,
      // Standalone rows have no computed baseline — mirror the shown values so
      // the inline editor renders them; the client persists them verbatim.
      computed: {
        borrower,
        vehicleno,
        emiAmount,
        nextDue,
        lastPaid,
        paidCount,
        totalCount,
        derivedStatus,
        dpd,
        mandateStatus,
        nextAutoDebit,
        financier,
      },
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

  return <EmiTrackerClient rows={[...rows, ...standaloneRows]} metrics={metrics} mode={mode} />;
}
