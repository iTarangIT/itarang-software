/**
 * Shared NBFC route error helpers.
 *
 * NBFC route handlers throw prefix-tagged, human-safe errors for the controlled
 * 4xx cases (`UNAUTHORIZED: …`, `FORBIDDEN: …`, `NOT_FOUND: …`, `BAD_REQUEST: …`,
 * `VALIDATION`, `CONFLICT`). Anything else reaching a catch block is an
 * *unexpected* 500 — a raw DB error, a null deref, etc. — whose message must NOT
 * be shown to the client. Leaking it surfaced an internal SQL query
 * ("Failed query: select role, role_id from nbfc_users …") straight into the
 * Acquire UI when a migration was missing.
 *
 * `clientError` is the single gate: pass-through for the controlled prefixes,
 * generic message (plus a server-side log of the real text) for everything else.
 */

/** Tags for errors the app raises deliberately and is safe to show the user. */
const SAFE_PREFIXES =
  /^(UNAUTHORIZED|FORBIDDEN|NOT_FOUND|BAD_REQUEST|VALIDATION|CONFLICT|TOO_MANY|PAYMENT_REQUIRED|GONE)\b/;

/**
 * Returns a client-safe error string for the `error` field of a JSON response.
 * Controlled, prefix-tagged messages pass through unchanged; any other (i.e. a
 * genuine 500) is logged server-side and replaced with a generic message so no
 * internal/SQL detail reaches the browser.
 */
export function clientError(msg: string): string {
  if (SAFE_PREFIXES.test(msg)) return msg;
  // Real cause stays in the server logs; never on the wire.
  console.error("[nbfc] unhandled route error:", msg);
  return "Something went wrong on our end. Please try again, or contact support if it persists.";
}
