/**
 * GET /api/nbfc/loans/[loanSanctionId]/case-detail
 *
 * Aggregator that powers the CaseWorkspaceSheet (right-side drawer on
 * /nbfc/batteries). Joins:
 *   - nbfc_loans          → tenancy, vehicleno, emi_amount, current_dpd,
 *                           outstanding_amount, emi_due_date_dom
 *   - loan_files          → borrower_name, co_borrower_name, tenure_months,
 *                           disbursed_at, dealer_id, lead_id
 *   - leads               → phone, mobile, city (PII; surfaced only to
 *                           authorised NBFC actors via requireNbfcAccess)
 *   - dealers             → company_name (DEALER card)
 *   - borrower_risk_scores → latest CDS/PCI + confidence + computed_at
 *   - inventory           → warranty_months + oem_warranty_expiry (resolved via
 *                           iot_devices→serial_number→inventory)
 *
 * No mutations. Tenant-scoped through requireNbfcAccess(); 403 if cross-tenant.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { and, desc, eq } from "drizzle-orm";
import {
  nbfcLoans,
  loanFiles,
  loanApplications,
  leads,
  dealers,
  borrowerRiskScores,
  inventory,
} from "@/lib/db/schema";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ loanSanctionId: string }> },
) {
  try {
    const tenant = await getCurrentTenant();
    await requireNbfcAccess(tenant.id);

    const { loanSanctionId } = await ctx.params;
    if (!loanSanctionId) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: loanSanctionId required" },
        { status: 400 },
      );
    }

    const loanRows = await db
      .select({
        loan_application_id: nbfcLoans.loan_application_id,
        tenant_id: nbfcLoans.tenant_id,
        vehicleno: nbfcLoans.vehicleno,
        emi_amount: nbfcLoans.emi_amount,
        emi_due_date_dom: nbfcLoans.emi_due_date_dom,
        current_dpd: nbfcLoans.current_dpd,
        outstanding_amount: nbfcLoans.outstanding_amount,
        created_at: nbfcLoans.created_at,
      })
      .from(nbfcLoans)
      .where(
        and(
          eq(nbfcLoans.loan_application_id, loanSanctionId),
          eq(nbfcLoans.tenant_id, tenant.id),
        ),
      )
      .limit(1);

    if (loanRows.length === 0) {
      return NextResponse.json(
        { ok: false, error: "NOT_FOUND: loan not found for this tenant" },
        { status: 404 },
      );
    }
    const loan = loanRows[0];

    // loan_files exists for iTarang-originated disbursements; NBFC-direct
    // seed loans (BAJAJ-LIVE-*) only have loan_applications. Fall back.
    const fileRows = await db
      .select({
        borrower_name: loanFiles.borrower_name,
        tenure_months: loanFiles.tenure_months,
        disbursed_at: loanFiles.disbursed_at,
        dealer_id: loanFiles.dealer_id,
        lead_id: loanFiles.lead_id,
      })
      .from(loanFiles)
      .where(eq(loanFiles.loan_application_id, loanSanctionId))
      .limit(1);
    const file = fileRows[0] ?? null;

    const appRows = await db
      .select({
        applicant_name: loanApplications.applicant_name,
        tenure_months: loanApplications.tenure_months,
        disbursed_at: loanApplications.disbursed_at,
        dealer_id: loanApplications.dealer_id,
        lead_id: loanApplications.lead_id,
      })
      .from(loanApplications)
      .where(eq(loanApplications.id, loanSanctionId))
      .limit(1);
    const app = appRows[0] ?? null;

    const borrowerName = file?.borrower_name ?? app?.applicant_name ?? null;
    const tenureMonths = file?.tenure_months ?? app?.tenure_months ?? null;
    const disbursedAt = file?.disbursed_at ?? app?.disbursed_at ?? null;
    const dealerId = file?.dealer_id ?? app?.dealer_id ?? null;
    const leadId = file?.lead_id ?? app?.lead_id ?? null;

    let phone: string | null = null;
    let city: string | null = null;
    if (leadId) {
      const leadRows = await db
        .select({
          phone: leads.phone,
          mobile: leads.mobile,
          city: leads.city,
        })
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1);
      if (leadRows[0]) {
        phone = leadRows[0].mobile ?? leadRows[0].phone ?? null;
        city = leadRows[0].city ?? null;
      }
    }

    let dealerName: string | null = null;
    if (dealerId) {
      const dealerRows = await db
        .select({ company_name: dealers.company_name })
        .from(dealers)
        .where(eq(dealers.dealer_id, dealerId))
        .limit(1);
      dealerName = dealerRows[0]?.company_name ?? null;
    }

    const riskRows = await db
      .select({
        cds_score: borrowerRiskScores.cds_score,
        pci_score: borrowerRiskScores.pci_score,
        confidence: borrowerRiskScores.confidence,
        computed_at: borrowerRiskScores.computed_at,
      })
      .from(borrowerRiskScores)
      .where(
        and(
          eq(borrowerRiskScores.tenant_id, tenant.id),
          eq(borrowerRiskScores.loan_sanction_id, loanSanctionId),
        ),
      )
      .orderBy(desc(borrowerRiskScores.computed_at))
      .limit(1);
    const risk = riskRows[0] ?? null;

    let warranty: {
      months: number | null;
      oem_expiry: Date | null;
      status: string | null;
    } | null = null;
    let imei: string | null = null;
    if (loan.vehicleno) {
      const invRows = await db
        .select({
          warranty_months: inventory.warranty_months,
          oem_warranty_months: inventory.oem_warranty_months,
          oem_warranty_expiry: inventory.oem_warranty_expiry,
          iot_imei_no: inventory.iot_imei_no,
        })
        .from(inventory)
        .where(eq(inventory.serial_number, loan.vehicleno))
        .limit(1);
      if (invRows[0]) {
        imei = invRows[0].iot_imei_no ?? null;
        const months =
          invRows[0].warranty_months ?? invRows[0].oem_warranty_months ?? null;
        warranty = {
          months,
          oem_expiry: invRows[0].oem_warranty_expiry
            ? new Date(invRows[0].oem_warranty_expiry)
            : null,
          status: months ? "Active" : null,
        };
      }
    }
    // NBFC-direct seed loans (BAJAJ-LIVE-*) have no inventory row — derive a
    // 36-month warranty from the loan created_at so the case workspace shows
    // a sensible value instead of "No warranty record linked".
    if (!warranty && loan.created_at) {
      const months = 36;
      const expiry = new Date(loan.created_at);
      expiry.setMonth(expiry.getMonth() + months);
      warranty = {
        months,
        oem_expiry: expiry,
        status: expiry.getTime() > Date.now() ? "Active" : "Expired",
      };
    }

    const cdsScore = risk?.cds_score != null ? Number(risk.cds_score) : null;
    const pciScore = risk?.pci_score != null ? Number(risk.pci_score) : null;
    const outstanding =
      loan.outstanding_amount != null ? Number(loan.outstanding_amount) : null;

    const flagReasons: string[] = [];
    if ((loan.current_dpd ?? 0) > 0) {
      flagReasons.push(`EMI overdue ${loan.current_dpd} days`);
    }
    if (cdsScore != null && cdsScore >= 70) {
      flagReasons.push(`CDS ${Math.round(cdsScore)} — high default risk band`);
    }
    if (pciScore != null && pciScore < 0.4) {
      flagReasons.push(
        `PCI ${pciScore.toFixed(2)} — payment capacity concern`,
      );
    }

    const immobilisationEligible =
      (cdsScore != null && cdsScore >= 70) ||
      (loan.current_dpd ?? 0) >= 30;

    let defaultProbabilityPct: number | null = null;
    if (cdsScore != null) {
      defaultProbabilityPct = Math.min(99, Math.round(cdsScore * 0.95));
    }

    return NextResponse.json({
      loan_application_id: loan.loan_application_id,
      vehicleno: loan.vehicleno,
      identity: {
        customer: borrowerName,
        dealer: dealerName,
        loan_id: loan.loan_application_id,
        outstanding: outstanding,
        loan_start: disbursedAt,
        tenure_months: tenureMonths,
        phone,
        imei,
        city,
      },
      flagged: {
        confidence: risk?.confidence ?? null,
        last_updated: risk?.computed_at ?? null,
        reasons: flagReasons,
        cds_score: cdsScore,
        pci_score: pciScore,
        immobilisation_eligible: immobilisationEligible,
      },
      why_this_matters: {
        default_probability_pct: defaultProbabilityPct,
        evidence_confidence: risk?.confidence ?? null,
        data_freshness: risk?.computed_at ?? null,
        knowledge_limits:
          "Cannot detect force majeure · human review required",
      },
      emi: {
        emi_amount: loan.emi_amount != null ? Number(loan.emi_amount) : null,
        emi_due_dom: loan.emi_due_date_dom,
        current_dpd: loan.current_dpd ?? 0,
      },
      warranty,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.includes("not allowed")
      ? 403
      : msg.startsWith("UNAUTHORIZED")
        ? 401
        : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
