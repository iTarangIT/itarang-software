/**
 * The cash / financed split for a `cash_refinance` lot.
 *
 * Pure arithmetic, in its own module with no database import, so the dealer's
 * bidding screen can show the split BEFORE a bid is placed while the server
 * raises the sanction from the same function afterwards. A dealer who learns
 * how much cash they owe only after winning has been told the price of the lot
 * but not the price of the deal.
 */

/**
 * A used asset is not financed to 100 %: the dealer puts money in, which is
 * what keeps them in the deal. 30 % is what the BRD's worked example implies —
 * roughly ₹40k financed against a ₹60k new-asset price.
 */
export const REFINANCE_DOWN_PAYMENT_PCT = 0.3;
export const REFINANCE_TENURE_MONTHS = 12;
export const REFINANCE_ROI = 24;

export interface RefinanceSplit {
  total: number;
  cash_due: number;
  financed: number;
  tenure_months: number;
  roi: number;
  indicative_emi: number;
}

/** Flat-rate EMI, matching how the loan calculator quotes a used-asset deal. */
export function refinanceSplit(total: number): RefinanceSplit {
  const cash = Math.round(total * REFINANCE_DOWN_PAYMENT_PCT);
  const financed = Math.max(0, total - cash);
  const interest =
    (financed * (REFINANCE_ROI / 100) * REFINANCE_TENURE_MONTHS) / 12;
  return {
    total,
    cash_due: cash,
    financed,
    tenure_months: REFINANCE_TENURE_MONTHS,
    roi: REFINANCE_ROI,
    indicative_emi:
      financed > 0
        ? Math.round((financed + interest) / REFINANCE_TENURE_MONTHS)
        : 0,
  };
}
