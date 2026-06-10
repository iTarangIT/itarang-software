import type { BureauKind, CreditBureauProvider } from './types';
import { CibilProvider } from './cibil';
import { EquifaxProvider } from './equifax';

// Reserved-but-not-implemented providers throw at construction time so a
// misconfigured nbfc_loan_products.credit_bureau row is caught at the route
// boundary instead of silently degrading.

class UnimplementedProvider implements CreditBureauProvider {
  readonly bureau: BureauKind;
  constructor(bureau: BureauKind) {
    this.bureau = bureau;
  }
  async fetchScore() {
    return {
      bureau: this.bureau,
      score: null,
      error: {
        code: 'BUREAU_NOT_IMPLEMENTED',
        category: 'tier_unauthorized',
        message: `Credit bureau '${this.bureau}' is reserved but not yet implemented.`,
        suggestion: null,
        retryable: false,
      },
      raw: null,
    };
  }
  async fetchReport() {
    return {
      bureau: this.bureau,
      score: null,
      accounts_summary: null,
      recent_enquiries: null,
      error: {
        code: 'BUREAU_NOT_IMPLEMENTED',
        category: 'tier_unauthorized',
        message: `Credit bureau '${this.bureau}' is reserved but not yet implemented.`,
        suggestion: null,
        retryable: false,
      },
      raw: null,
    };
  }
}

// Platform-wide default bureau. BRD Addendum §4.3 targets "Equifax replaces
// CIBIL platform-wide", but the Equifax provider is still a stub (Phase 3 —
// no live HTTP client / EQUIFAX_* creds), so defaulting to it makes every
// score/report call fail with EQUIFAX_NOT_PROVISIONED. Until provisioning
// lands, the working provider is CIBIL — keep it as the default and flip this
// one constant to 'equifax' when EquifaxProvider is actually wired up.
// Applied when:
//   (a) the caller has no product context (e.g. KYC-time score fetch runs
//       before the dealer picks NBFCs at Section G), or
//   (b) the matched nbfc_loan_products.credit_bureau is NULL (legacy rows
//       pre-E-130 that haven't been backfilled).
export const DEFAULT_PLATFORM_BUREAU: BureauKind = 'cibil';

export function getCreditBureauProvider(
  bureau: BureauKind | string | null | undefined,
): CreditBureauProvider {
  const resolved = (bureau ?? DEFAULT_PLATFORM_BUREAU) as BureauKind;
  switch (resolved) {
    case 'cibil':
      return new CibilProvider();
    case 'equifax':
      return new EquifaxProvider();
    case 'crif':
    case 'experian':
      return new UnimplementedProvider(resolved);
    default:
      // Unknown value — fall back to the platform default so the call doesn't
      // crash, but log so monitoring catches mis-set columns. Use the working
      // provider for the default (not the Equifax stub) so a mis-set column
      // degrades gracefully instead of erroring out.
      console.warn(
        `[credit-bureau] Unknown credit_bureau value '${bureau}'; falling back to ${DEFAULT_PLATFORM_BUREAU}`,
      );
      return new CibilProvider();
  }
}
