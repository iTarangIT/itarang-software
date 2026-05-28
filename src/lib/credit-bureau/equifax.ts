import type {
  CreditBureauProvider,
  ProviderError,
  ProviderInput,
  ReportResult,
  ScoreResult,
} from './types';

// Equifax provider — stub. Credentials and the live HTTP client land when
// the NBFC partnership / Decentro tier is provisioned. The router still
// dispatches to this provider for `credit_bureau='equifax'` products so the
// failure surfaces at the route layer instead of silently falling back.
//
// Expected env vars (when implemented):
//   EQUIFAX_API_URL          — base URL
//   EQUIFAX_API_USERNAME     — basic-auth or client id
//   EQUIFAX_API_PASSWORD     — basic-auth secret or client secret
//   EQUIFAX_MEMBER_NUMBER    — Equifax member number / customer id
//   EQUIFAX_SECURITY_CODE    — Equifax security code

const NOT_IMPLEMENTED: ProviderError = {
  code: 'EQUIFAX_NOT_PROVISIONED',
  category: 'tier_unauthorized',
  message:
    'Equifax provider is not yet wired up. Set EQUIFAX_* credentials in .env.local and implement EquifaxProvider.fetchScore / .fetchReport before changing nbfc_loan_products.credit_bureau to equifax.',
  suggestion:
    'Until provisioning lands, leave nbfc_loan_products.credit_bureau as cibil (or NULL).',
  retryable: false,
};

export class EquifaxProvider implements CreditBureauProvider {
  readonly bureau = 'equifax' as const;

  async fetchScore(_input: ProviderInput): Promise<ScoreResult> {
    return {
      bureau: 'equifax',
      score: null,
      error: NOT_IMPLEMENTED,
      raw: null,
    };
  }

  async fetchReport(_input: ProviderInput): Promise<ReportResult> {
    return {
      bureau: 'equifax',
      score: null,
      accounts_summary: null,
      recent_enquiries: null,
      error: NOT_IMPLEMENTED,
      raw: null,
    };
  }
}
