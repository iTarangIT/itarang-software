// Dealer-side ID masking for API responses — tracker ID 119, point 3.
//
// Same rule as a customer's KYC (decided 21 Oct):
//   - the owner's Aadhaar never leaves the server in full — `XXXX XXXX 1234`
//     for every role (aadhaarMask.ts);
//   - PAN and bank account number go in full only to Admin, the CEO and the
//     Sales Head (FULL_ID_ROLES); everyone else gets `XXXXXX234F` and
//     `XXXXXX1234`.
//
// Used by the dealer validation page, the WhatsApp onboarding console and the
// dealer detail API. Pure: no db import.

import { FULL_ID_ROLES } from "@/lib/auth/leadAccessRules";
import { maskAadhaar, maskAadhaarDeep } from "./aadhaarMask";
import { isPan, maskPan, maskPanDeep } from "./panMask";

/** Does this role see full PAN and bank account numbers? */
export function seesFullDealerIds(role: string | null | undefined): boolean {
  return (FULL_ID_ROLES as readonly string[]).includes(role ?? "");
}

/** Does this look like a value maskBankAccount() produced? */
export function isMaskedBankAccount(value: unknown): boolean {
  return typeof value === "string" && /^[Xx*•]{2,}\d{1,4}$/.test(value.replace(/\s/g, ""));
}

/** `XXXXXX1234` for an account number; null/empty stays null; a mask passes through. */
export function maskBankAccount(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).replace(/\s/g, "");
  if (!raw) return null;
  if (isMaskedBankAccount(raw)) return raw;
  return raw.length <= 4 ? "XXXXXX" : `XXXXXX${raw.slice(-4)}`;
}

const ACCOUNT_KEY = /^(bank_?)?(account|acct)_?(no|num|number)$|^accountNumber$|^bankAccountNumber$/i;
const AADHAAR_KEY = /aadhaar|aadhar/i;

/**
 * A copy of `value` with dealer IDs masked at any depth: Aadhaar (by key) for
 * everyone; PAN (by value) and account numbers (by key) unless `fullIds`.
 */
export function maskDealerIdsDeep<T>(value: T, fullIds: boolean): T {
  const noAadhaar = maskAadhaarDeep(value);
  return fullIds ? noAadhaar : (maskAccountsDeep(maskPanDeep(noAadhaar), false) as T);
}

function maskAccountsDeep(value: unknown, keyIsAccount: boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => maskAccountsDeep(v, keyIsAccount));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskAccountsDeep(v, ACCOUNT_KEY.test(k));
    }
    return out;
  }
  if (keyIsAccount && (typeof value === "string" || typeof value === "number")) return maskBankAccount(value);
  return value;
}

const PAN_IN_TEXT = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/gi;
// 9–18 digits (bank account numbers), optionally broken by single spaces or
// hyphens; not part of a longer number. A 12-digit run is masked too, which
// also covers an Aadhaar written into free text.
const ACCOUNT_IN_TEXT = /(?<![\d])\d(?:[ -]?\d){8,17}(?![\d])/g;

/**
 * ID 119: PAN and account numbers written INSIDE a sentence (verification
 * warnings such as "Bank account 1234567890 could not be verified."). The
 * value-anchored maskers above never see them. Unless `fullIds`, every
 * PAN-shaped word becomes `XXXXXX234F` and every 9–18 digit run `XXXXXX1234`.
 */
export function maskIdsInText(text: string | null | undefined, fullIds: boolean): string | null {
  if (text === null || text === undefined) return null;
  if (fullIds) return text;
  return text
    .replace(PAN_IN_TEXT, (m) => maskPan(m) ?? m)
    .replace(ACCOUNT_IN_TEXT, (m) => maskBankAccount(m.replace(/[ -]/g, "")) ?? m);
}

/**
 * The WhatsApp console's captured-details list ({ key, value } rows, see
 * whatsapp/captured-details.ts): the key says what the value is, so mask by it.
 */
export function maskCapturedIds<T extends { key: string; value: string }>(fields: T[], fullIds: boolean): T[] {
  return fields.map((f) => {
    if (AADHAAR_KEY.test(f.key)) return { ...f, value: maskAadhaar(f.value) ?? "" };
    if (fullIds) return f;
    if (ACCOUNT_KEY.test(f.key)) return { ...f, value: maskBankAccount(f.value) ?? "" };
    if (isPan(f.value)) return { ...f, value: maskPan(f.value) ?? "" };
    return f;
  });
}
