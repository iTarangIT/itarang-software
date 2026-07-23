// Bank account-type helpers shared by the WhatsApp onboarding orchestrator and
// the admin dealer-verification API.
//
// Indian bank documents frequently DON'T print the account type: cancelled
// cheques almost never do, and many statements omit it too. When the document
// is silent, we infer from the account HOLDER: the RBI bars business/firm
// entities from holding SAVINGS accounts, so an account held in a firm/business
// name is a CURRENT account. For an individual holder we return "" rather than
// guess (a sole proprietor may legitimately use a personal savings account).

// Tokens that mark a name as a business/firm rather than a person. Tuned for the
// dealer domain (EV / battery / auto trade). Bare ambiguous words (e.g. "co")
// are deliberately excluded to avoid false positives on personal names.
const BUSINESS_TOKENS =
  /\b(enterprises?|traders?|trading|industries|udyog|agenc(?:y|ies)|associates?|motors?|automobiles?|auto|corporation|corp|company|pvt|private|limited|ltd|llp|firm|sons|brothers|bros|store|stores|mart|works|solutions|services|marketing|distributors?|suppliers?|electricals?|electric|batter(?:y|ies)|energy|power|sales|agencies)\b/i;

export function looksLikeBusinessName(name?: string | null): boolean {
  return !!name && BUSINESS_TOKENS.test(name);
}

/** Normalise a raw extracted account-type label to 'savings' | 'current' | ''. */
export function normalizeAccountType(raw?: string | null): "savings" | "current" | "" {
  const s = (raw || "").toLowerCase();
  if (/\b(sav|sb|sba)\b|saving/.test(s)) return "savings";
  if (/\b(cur|ca|cd|od)\b|current|overdraft/.test(s)) return "current";
  return "";
}

/**
 * Infer the account type when the document didn't state one. Returns "current"
 * when the holder (or the company on file) is a business/firm; "" otherwise.
 */
export function inferAccountType(
  holderName?: string | null,
  companyName?: string | null,
): "current" | "" {
  if (looksLikeBusinessName(holderName) || looksLikeBusinessName(companyName)) {
    return "current";
  }
  // Holder name equals the company name on file → a business account.
  if (
    holderName &&
    companyName &&
    holderName.trim().toLowerCase() === companyName.trim().toLowerCase()
  ) {
    return "current";
  }
  return "";
}

/**
 * Resolve the display/canonical account type: prefer a real extracted/normalised
 * value, else infer from the holder/company. Returns "" only when we truly can't
 * tell (individual holder, no printed type).
 */
export function resolveAccountType(
  rawExtracted?: string | null,
  holderName?: string | null,
  companyName?: string | null,
): "savings" | "current" | "" {
  const normalised = normalizeAccountType(rawExtracted);
  if (normalised) return normalised;
  return inferAccountType(holderName, companyName);
}
