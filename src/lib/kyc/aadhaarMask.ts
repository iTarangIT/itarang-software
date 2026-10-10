// Aadhaar masking for API responses — tracker ID 119.
//
// The KYC start check, the borrower details and the co-borrower record used to
// send the full 12-digit Aadhaar to the browser. The screens only ever display
// it masked, so the server now masks it before it leaves: `XXXX XXXX 1234`.
//
// The borrower form round-trips what it loaded back to the save routes
// (autosave every few seconds), so a masked value can come BACK in a save. The
// save routes call restoreMaskedAadhaar() to keep the stored number instead of
// overwriting it with the mask. Pure: no db import.

/** `XXXX XXXX 1234` for a full number; null/empty stays null; already-masked passes through. */
export function maskAadhaar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (isMaskedAadhaar(raw)) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 4) return "XXXX XXXX XXXX";
  return `XXXX XXXX ${digits.slice(-4)}`;
}

/** Does this look like a value maskAadhaar() produced (or Digio's `XXXXXXXX1234`)? */
export function isMaskedAadhaar(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^[Xx*]{4}[\s-]?[Xx*]{4}[\s-]?(\d{4}|[Xx*]{4})$/.test(value.trim());
}

const AADHAAR_KEY = /aadhaar|aadhar|\buid\b/i;

/**
 * A copy of `value` with every Aadhaar-looking field masked, at any depth.
 * A field counts when its KEY names Aadhaar (aadhaar_no, aadhaarNumber, …) and
 * its value is a string/number of 12 digits (spaces/dashes allowed). Other
 * fields — including Aadhaar document URLs and verification statuses — are
 * left alone.
 */
export function maskAadhaarDeep<T>(value: T): T {
  return walk(value, false) as T;
}

function walk(value: unknown, keyIsAadhaar: boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => walk(v, keyIsAadhaar));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, AADHAAR_KEY.test(k));
    }
    return out;
  }
  if (keyIsAadhaar && (typeof value === "string" || typeof value === "number")) {
    const digits = String(value).replace(/[\s-]/g, "");
    if (/^\d{12}$/.test(digits)) return maskAadhaar(digits);
  }
  return value;
}

/**
 * The value to SAVE for an Aadhaar field: the incoming one, unless it is the
 * mask the server handed out — then whatever was stored before.
 */
export function restoreMaskedAadhaar(
  incoming: unknown,
  stored: unknown,
): unknown {
  return isMaskedAadhaar(incoming) ? (stored ?? null) : incoming;
}

/**
 * restoreMaskedAadhaar() over a whole object: every Aadhaar-keyed field of
 * `incoming` that holds a mask is replaced by the value at the same path in
 * `stored`. Used where a whole draft blob is saved back.
 */
export function restoreMaskedAadhaarDeep<T>(incoming: T, stored: unknown): T {
  return restoreWalk(incoming, stored, false) as T;
}

function restoreWalk(incoming: unknown, stored: unknown, keyIsAadhaar: boolean): unknown {
  if (keyIsAadhaar && isMaskedAadhaar(incoming)) {
    return stored ?? null;
  }
  if (Array.isArray(incoming)) {
    const s = Array.isArray(stored) ? stored : [];
    return incoming.map((v, i) => restoreWalk(v, s[i], keyIsAadhaar));
  }
  if (incoming && typeof incoming === "object" && !(incoming instanceof Date)) {
    const s =
      stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
      out[k] = restoreWalk(v, s[k], AADHAAR_KEY.test(k));
    }
    return out;
  }
  return incoming;
}
