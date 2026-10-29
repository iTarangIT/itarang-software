/**
 * ID 206 — the session's sign-in time, read off the access-token claims.
 *
 * The local session check (auth-utils sessionUser, ID 203) builds the user from
 * the JWT and so has no `last_sign_in_at`; without it recordLoginEvent records
 * nothing and the Ops Console login history stops. The token's `amr` claim
 * carries `{ method, timestamp }` per authentication method, the timestamp
 * being when that method succeeded (Unix seconds). It stays the same across
 * token refreshes, so it is the sign-in time recordLoginEvent dedupes on.
 *
 * The latest entry wins (a password login followed by an OTP step-up is one
 * sign-in at the later time). String-form `amr` carries no time → undefined.
 */
export function signInTimeFromClaims(claims: { amr?: unknown } | null | undefined): string | undefined {
  const amr = claims?.amr;
  if (!Array.isArray(amr)) return undefined;
  let latest = 0;
  for (const entry of amr) {
    const ts = typeof entry === "object" && entry !== null ? (entry as { timestamp?: unknown }).timestamp : undefined;
    if (typeof ts === "number" && Number.isFinite(ts) && ts > latest) latest = ts;
  }
  return latest > 0 ? new Date(latest * 1000).toISOString() : undefined;
}
