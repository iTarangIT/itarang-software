/**
 * NBFC identity format validators.
 *
 * Pure functions for validating identity fields used in the NBFC master
 * details form (BRD §6.0.3). Same code path is used by the master form
 * (E-003) and the API endpoint at /api/admin/nbfc/validate-identity (E-004).
 *
 * Regex sources (verbatim from BRD §6.0.3):
 *   - RBI CoR: N-XX.XXXXX.XX.XX.XXXX.XXXXX.XX
 *   - GST:     2-digit state code + 10-char PAN + 1Z + 1 check
 *   - PAN:     5 letters + 4 digits + 1 letter, all uppercase
 *   - Phone:   10-digit numeric mobile
 *
 * Patterns reject case-mismatch (e.g. lowercase PAN) — no silent
 * normalisation that could mask data-entry errors (BRD non-functional rule).
 */

export const RBI_REGISTRATION_REGEX =
  /^N-\d{2}\.\d{5}\.\d{2}\.\d{2}\.\d{4}\.\d{5}\.\d{2}$/;

export const GST_REGEX = /^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}Z[A-Z\d]{1}$/;

export const PAN_REGEX = /^[A-Z]{5}\d{4}[A-Z]$/;

export const PHONE_REGEX = /^\d{10}$/;

export interface IdentityFields {
  rbiRegistrationNo?: string;
  gstNumber?: string;
  panNumber?: string;
  primaryContactPhone?: string;
}

export interface IdentityErrors {
  rbiRegistrationNo: string | null;
  gstNumber: string | null;
  panNumber: string | null;
  primaryContactPhone: string | null;
}

export interface IdentityValidationResult {
  ok: boolean;
  errors: IdentityErrors;
}

export function validateRbiRegistration(value: string): string | null {
  return RBI_REGISTRATION_REGEX.test(value)
    ? null
    : "RBI CoR must match N-XX.XXXXX.XX.XX.XXXX.XXXXX.XX";
}

export function validateGst(value: string): string | null {
  return GST_REGEX.test(value)
    ? null
    : "GST must be 2-digit state code + 10-char PAN + 1Z + 1 check";
}

export function validatePan(value: string): string | null {
  return PAN_REGEX.test(value)
    ? null
    : "PAN must be 5 uppercase letters + 4 digits + 1 uppercase letter";
}

export function validatePhone(value: string): string | null {
  return PHONE_REGEX.test(value)
    ? null
    : "Primary contact phone must be a 10-digit numeric mobile number";
}

/**
 * Validate the NBFC identity payload. Only fields that are explicitly
 * provided (non-undefined) are checked; missing fields don't generate
 * errors so that this validator can be reused for partial form updates.
 *
 * Returns ok=true iff every provided field matches its pattern.
 */
export function validateIdentity(input: IdentityFields): IdentityValidationResult {
  const errors: IdentityErrors = {
    rbiRegistrationNo: null,
    gstNumber: null,
    panNumber: null,
    primaryContactPhone: null,
  };

  if (input.rbiRegistrationNo !== undefined) {
    errors.rbiRegistrationNo = validateRbiRegistration(input.rbiRegistrationNo);
  }
  if (input.gstNumber !== undefined) {
    errors.gstNumber = validateGst(input.gstNumber);
  }
  if (input.panNumber !== undefined) {
    errors.panNumber = validatePan(input.panNumber);
  }
  if (input.primaryContactPhone !== undefined) {
    errors.primaryContactPhone = validatePhone(input.primaryContactPhone);
  }

  const ok =
    errors.rbiRegistrationNo === null &&
    errors.gstNumber === null &&
    errors.panNumber === null &&
    errors.primaryContactPhone === null;

  return { ok, errors };
}
