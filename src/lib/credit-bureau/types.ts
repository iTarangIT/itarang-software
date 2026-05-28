// BRD Addendum V0.1 §4.3 — Bureau-abstracted credit gate. Per-product
// `nbfc_loan_products.credit_bureau` (varchar enum; default 'equifax', legacy
// 'cibil', reserved 'crif' | 'experian') selects which provider services the
// score / report call. The route handler asks the router for a provider; the
// provider returns a normalized result so the handler does not branch on
// vendor specifics.

export type BureauKind = 'equifax' | 'cibil' | 'crif' | 'experian';

// Bureau-agnostic applicant input. Mirrors the union of what each provider
// requires; individual providers may ignore fields they do not use.
export type ProviderInput = {
  name: string;
  pan: string;
  dob: string; // YYYY-MM-DD
  phone: string;
  address: string;
  pincode?: string;
  address_type?: 'H' | 'O' | 'X';
};

// Bureau-neutral error category. The same semantics show up across bureaus
// even when each one uses a different raw `code`; callers branch on this.
export type ProviderErrorCategory =
  | 'score_not_found'
  | 'consumer_not_found'
  | 'invalid_pan'
  | 'invalid_mobile'
  | 'tier_unauthorized'
  | 'network'
  | 'unknown';

export type ProviderError = {
  // Provider-specific error code (e.g. Decentro 'error_credits_score_not_found').
  code: string | null;
  // Bureau-agnostic category callers should branch on.
  category: ProviderErrorCategory;
  // Plain-English message safe to show admins.
  message: string;
  // Actionable next-step hint, or null when the provider has no specific
  // suggestion (e.g. unknown errors).
  suggestion: string | null;
  // Best-effort hint about whether retrying is sensible. Routes use this to
  // pick between a soft-fail UX and a hard-fail UX.
  retryable: boolean;
};

export type ScoreResult = {
  bureau: BureauKind;
  // Null when the provider returned an error or the consumer was not found.
  score: number | null;
  error: ProviderError | null;
  // The raw provider payload, preserved for audit. Persisted to
  // kyc_verifications.api_response so the bureau response is forensically
  // available even if our normalized shape drifts.
  raw: unknown;
};

export type ReportAccountSummary = {
  total_accounts: number | null;
  active_accounts: number | null;
  closed_accounts: number | null;
  total_balance: number | null;
  total_overdue: number | null;
};

export type ReportResult = {
  bureau: BureauKind;
  score: number | null;
  accounts_summary: ReportAccountSummary | null;
  // Number of credit enquiries in the last N months (where N is bureau-defined).
  recent_enquiries: number | null;
  error: ProviderError | null;
  raw: unknown;
};

export interface CreditBureauProvider {
  readonly bureau: BureauKind;
  fetchScore(input: ProviderInput): Promise<ScoreResult>;
  fetchReport(input: ProviderInput): Promise<ReportResult>;
}
