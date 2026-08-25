import type {
  CustomerProfile,
  MatchHit,
  MatchMiss,
  MatchResult,
  ProductBands,
  ResidentStatus,
} from './types';

// What the matcher consumes from `nbfc_loan_products`. Defined here so the
// matcher stays pure (no DB import) and is callable from tests + the loader.
export type LoanProductRow = {
  id: number;
  nbfc_id: number;
  product_name: string;
  status: string;
  eligible_battery_categories: string[] | null;
  loan_amount_min: number;
  loan_amount_max: number;
  tenure_months_min: number;
  tenure_months_max: number;
  min_roi_pct: string;
  max_roi_pct: string;
  down_payment_pct: string;
  active_locations: { state: string; city: string }[] | null;
  processing_fee_owned_rupees: number | null;
  processing_fee_rented_rupees: number | null;
  health_life_insurance_owned_rupees: number | null;
  health_life_insurance_rented_rupees: number | null;
  disbursement_tat_hours: number | null;
  min_credit_score: number | null;
  max_credit_score: number | null;
  // E-115 — null means legacy row (unknown), false means bureau check waived,
  // true means min/max gate is enforced when score is known.
  cibil_required: boolean | null;
  // Carried for DISPLAY only — the matcher does not read these. A borrower
  // comparing two schemes pays the file charge out of pocket exactly like the
  // processing fee, so it has to reach the card; leaving it off made two
  // schemes look identically priced when they were not.
  file_charge_fixed?: string | null;
  file_charge_pct?: string | null;
  subvention_available?: boolean | null;
};

function resolveFeeByOwnership(
  status: ResidentStatus | null,
  owned: number | null,
  rented: number | null,
): number | null {
  if (status === 'owned') return owned;
  if (status === 'rented') return rented;
  return owned ?? rented;
}

function evaluateProduct(
  customer: CustomerProfile,
  p: LoanProductRow,
): { reasons: string[]; bands: ProductBands } {
  const reasons: string[] = [];

  if (p.status !== 'active') {
    reasons.push('Product not active');
  }

  if (
    p.eligible_battery_categories &&
    p.eligible_battery_categories.length > 0 &&
    customer.battery_category &&
    !p.eligible_battery_categories.includes(customer.battery_category)
  ) {
    reasons.push(
      `Battery category '${customer.battery_category}' not in eligible list`,
    );
  }

  if (p.active_locations && p.active_locations.length > 0) {
    const matchesLocation = p.active_locations.some((loc) => {
      const stateOk = !loc.state || !customer.state || loc.state === customer.state;
      const cityOk = !loc.city || !customer.city || loc.city === customer.city;
      return stateOk && cityOk;
    });
    if (!matchesLocation) {
      reasons.push(
        `Location '${customer.state ?? ''}/${customer.city ?? ''}' not served`,
      );
    }
  }

  if (customer.loan_amount != null) {
    if (customer.loan_amount < p.loan_amount_min) {
      reasons.push(
        `Amount ${customer.loan_amount} below min ${p.loan_amount_min}`,
      );
    } else if (customer.loan_amount > p.loan_amount_max) {
      reasons.push(
        `Amount ${customer.loan_amount} above max ${p.loan_amount_max}`,
      );
    }
  }

  if (p.cibil_required === true && customer.credit_score != null) {
    if (p.min_credit_score != null && customer.credit_score < p.min_credit_score) {
      reasons.push(
        `Credit score ${customer.credit_score} below min ${p.min_credit_score}`,
      );
    }
    if (p.max_credit_score != null && customer.credit_score > p.max_credit_score) {
      reasons.push(
        `Credit score ${customer.credit_score} above max ${p.max_credit_score}`,
      );
    }
  }

  const bands: ProductBands = {
    loan_amount_min: p.loan_amount_min,
    loan_amount_max: p.loan_amount_max,
    tenure_months_min: p.tenure_months_min,
    tenure_months_max: p.tenure_months_max,
    min_roi_pct: p.min_roi_pct,
    max_roi_pct: p.max_roi_pct,
    down_payment_pct: p.down_payment_pct,
    processing_fee_rupees: resolveFeeByOwnership(
      customer.resident_status,
      p.processing_fee_owned_rupees,
      p.processing_fee_rented_rupees,
    ),
    health_life_insurance_rupees: resolveFeeByOwnership(
      customer.resident_status,
      p.health_life_insurance_owned_rupees,
      p.health_life_insurance_rented_rupees,
    ),
    disbursement_tat_hours: p.disbursement_tat_hours,
  };

  return { reasons, bands };
}

export function matchProducts(
  customer: CustomerProfile,
  products: LoanProductRow[],
): MatchResult {
  const hits: MatchHit[] = [];
  const misses: MatchMiss[] = [];

  for (const p of products) {
    const { reasons, bands } = evaluateProduct(customer, p);
    if (reasons.length === 0) {
      hits.push({
        product_id: p.id,
        nbfc_id: p.nbfc_id,
        product_name: p.product_name,
        bands,
      });
    } else {
      misses.push({ product_id: p.id, nbfc_id: p.nbfc_id, reasons });
    }
  }

  return { hits, misses };
}
