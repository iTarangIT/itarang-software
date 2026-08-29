/**
 * Standard reducing-balance EMI. Pure; used to prefill an NBFC's offer form from
 * the indicated loan product (E-275). Rounded to the rupee.
 */
export function computeEmi(principal: number, annualRoiPct: number, tenureMonths: number): number {
  if (!(principal > 0) || !(tenureMonths > 0)) return 0;
  const r = annualRoiPct / 12 / 100;
  if (r <= 0) return Math.round(principal / tenureMonths);
  const pow = Math.pow(1 + r, tenureMonths);
  return Math.round((principal * r * pow) / (pow - 1));
}
