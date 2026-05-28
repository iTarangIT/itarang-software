// BRD Addendum V0.1 §4.2 / §4.2.1 — Business Rule Engine for pre-disbursement
// NBFC matching. The matcher fires at two points:
//   1. Admin Approve  — `loan_amount` and `credit_score` may be null.
//   2. Section G submit — `loan_amount` now known; re-filter to amount-band-eligible.
//
// `resident_status` does not gate a match; it selects which of the
// owned/rented fee columns surfaces in the result bands.

export type ResidentStatus = 'owned' | 'rented';

export type CustomerProfile = {
  battery_category: string | null;
  state: string | null;
  city: string | null;
  loan_amount: number | null;
  credit_score: number | null;
  resident_status: ResidentStatus | null;
};

export type ProductBands = {
  loan_amount_min: number;
  loan_amount_max: number;
  tenure_months_min: number;
  tenure_months_max: number;
  min_roi_pct: string;
  max_roi_pct: string;
  down_payment_pct: string;
  // Resolved against `resident_status`. Null when the resident_status is
  // unknown and the product has no owned/rented column populated.
  processing_fee_rupees: number | null;
  health_life_insurance_rupees: number | null;
  disbursement_tat_hours: number | null;
};

export type MatchHit = {
  product_id: number;
  nbfc_id: number;
  product_name: string;
  bands: ProductBands;
};

export type MatchMiss = {
  product_id: number;
  nbfc_id: number;
  // Human-readable. Surfaced to admin/audit when 0 hits route to the
  // "pick a favoured NBFC" path (Addendum §4.2 no-match handling).
  reasons: string[];
};

export type MatchResult = {
  hits: MatchHit[];
  misses: MatchMiss[];
};
