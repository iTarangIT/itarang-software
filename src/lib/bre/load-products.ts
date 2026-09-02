// DB-side loader for the BRE matcher. Caller must pass the integer
// `dealers.id` PK — the human-readable varchar `dealer_id` code must be
// resolved upstream (mirrors the section-g-options pattern).
//
// Routing model: A + D (auto-enroll, admin only blocks exceptions).
//   - Every active NBFC loan product is a candidate by default.
//   - `dealer_nbfc_assignments` is now an EXCLUSION list — a row with
//     status IN ('suspended','terminated') blocks that dealer↔NBFC pair.
//     Rows with status='active' (legacy admin pairings) are ignored.
//   - Geography / battery-category / amount / CIBIL filtering happens in
//     `src/lib/bre/match.ts` against the loan product's own declarations
//     (`active_locations`, `eligible_battery_categories`, etc.).

import { and, eq, inArray, isNotNull, notInArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import { dealerNbfcAssignments, nbfc, nbfcLoanProducts } from '@/lib/db/schema';
import type { LoanProductRow } from './match';

export type LoadedLoanProduct = LoanProductRow & {
  nbfc_short_name: string;
  nbfc_legal_name: string;
  // Human-readable NBFC code (e.g. "NBFC-7X9A8YCV"). Surfaced so dealer-facing
  // financing cards can show "iTarang Scheme N (NBFC-XXXX)" instead of the
  // real lender name.
  nbfc_id_code: string;
};

const BLOCKING_STATUSES = ['suspended', 'terminated'] as const;

export async function loadActiveProductsForDealer(
  dealerInternalId: number,
): Promise<LoadedLoanProduct[]> {
  // Resolve the set of NBFC ids explicitly blocked for this dealer.
  const blockedRows = await db
    .select({ nbfc_id: dealerNbfcAssignments.nbfc_id })
    .from(dealerNbfcAssignments)
    .where(
      and(
        eq(dealerNbfcAssignments.dealer_id, dealerInternalId),
        inArray(dealerNbfcAssignments.status, [...BLOCKING_STATUSES]),
      ),
    );
  const blockedNbfcIds = blockedRows.map((r) => r.nbfc_id);

  const baseSelect = db
    .select({
      id: nbfcLoanProducts.id,
      nbfc_id: nbfcLoanProducts.nbfc_id,
      nbfc_short_name: nbfc.short_name,
      nbfc_legal_name: nbfc.legal_name,
      nbfc_id_code: nbfc.nbfc_id,
      product_name: nbfcLoanProducts.product_name,
      status: nbfcLoanProducts.status,
      eligible_battery_categories: nbfcLoanProducts.eligible_battery_categories,
      loan_amount_min: nbfcLoanProducts.loan_amount_min,
      loan_amount_max: nbfcLoanProducts.loan_amount_max,
      tenure_months_min: nbfcLoanProducts.tenure_months_min,
      tenure_months_max: nbfcLoanProducts.tenure_months_max,
      min_roi_pct: nbfcLoanProducts.min_roi_pct,
      max_roi_pct: nbfcLoanProducts.max_roi_pct,
      down_payment_pct: nbfcLoanProducts.down_payment_pct,
      active_locations: nbfcLoanProducts.active_locations,
      processing_fee_owned_rupees: nbfcLoanProducts.processing_fee_owned_rupees,
      processing_fee_rented_rupees: nbfcLoanProducts.processing_fee_rented_rupees,
      health_life_insurance_owned_rupees:
        nbfcLoanProducts.health_life_insurance_owned_rupees,
      health_life_insurance_rented_rupees:
        nbfcLoanProducts.health_life_insurance_rented_rupees,
      disbursement_tat_hours: nbfcLoanProducts.disbursement_tat_hours,
      min_credit_score: nbfcLoanProducts.min_credit_score,
      max_credit_score: nbfcLoanProducts.max_credit_score,
      cibil_required: nbfcLoanProducts.cibil_required,
      // Display-only (see LoanProductRow) — the matcher ignores these.
      file_charge_fixed: nbfcLoanProducts.file_charge_fixed,
      file_charge_pct: nbfcLoanProducts.file_charge_pct,
      subvention_available: nbfcLoanProducts.subvention_available,
    })
    .from(nbfcLoanProducts)
    .innerJoin(nbfc, eq(nbfc.id, nbfcLoanProducts.nbfc_id));

  // Competitive routing can only deliver a lead to NBFCs bound to a portal
  // tenant. An unbound nbfc row (tenant_id IS NULL) can never receive the
  // lead — the submit-product-selection fan-out silently skips it — so it must
  // not be offered as a pickable Section G candidate. After the activation fix
  // (nbfc.tenant_id set on activate) + the E-139 backfill, every active NBFC is
  // bound, so this hides only broken / not-yet-activated rows.
  const conditions = [isNotNull(nbfc.tenant_id)];
  if (blockedNbfcIds.length > 0) {
    conditions.push(notInArray(nbfcLoanProducts.nbfc_id, blockedNbfcIds));
  }

  const rows = await baseSelect.where(and(...conditions));

  return rows.map((r) => ({
    id: r.id,
    nbfc_id: r.nbfc_id,
    nbfc_short_name: r.nbfc_short_name,
    nbfc_legal_name: r.nbfc_legal_name,
    nbfc_id_code: r.nbfc_id_code,
    product_name: r.product_name,
    status: r.status,
    eligible_battery_categories: r.eligible_battery_categories,
    loan_amount_min: r.loan_amount_min,
    loan_amount_max: r.loan_amount_max,
    tenure_months_min: r.tenure_months_min,
    tenure_months_max: r.tenure_months_max,
    min_roi_pct: String(r.min_roi_pct),
    max_roi_pct: String(r.max_roi_pct),
    down_payment_pct: String(r.down_payment_pct),
    active_locations: r.active_locations,
    processing_fee_owned_rupees: r.processing_fee_owned_rupees,
    processing_fee_rented_rupees: r.processing_fee_rented_rupees,
    health_life_insurance_owned_rupees: r.health_life_insurance_owned_rupees,
    health_life_insurance_rented_rupees: r.health_life_insurance_rented_rupees,
    disbursement_tat_hours: r.disbursement_tat_hours,
    min_credit_score: r.min_credit_score,
    max_credit_score: r.max_credit_score,
    cibil_required: r.cibil_required,
    // Display-only — see LoanProductRow. Must be repeated here as well as in
    // the select: this map re-shapes the row field by field, so anything added
    // to `baseSelect` alone is silently dropped on the way out.
    file_charge_fixed: r.file_charge_fixed,
    file_charge_pct: r.file_charge_pct,
    subvention_available: r.subvention_available,
  }));
}
