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
  /^(UNAUTHORIZED|FORBIDDEN|NOT_FOUND|BAD_REQUEST|VALIDATION|CONFLICT|TOO_MANY|PAYMENT_REQUIRED|INSUFFICIENT_FUNDS|PROVIDER_ERROR|GONE)\b/;

/**
 * Returns a client-safe error string for the `error` field of a JSON response.
 * Controlled, prefix-tagged messages pass through unchanged; any other (i.e. a
 * genuine 500) is logged server-side and replaced with a generic message so no
 * internal/SQL detail reaches the browser.
 *
 * Accepts either the error's `.message` string (legacy callers) or the whole
 * caught value. Pass the whole error when you can: Drizzle wraps DB failures in
 * a `DrizzleQueryError` whose `.message` is only "Failed query: …" — the real
 * Postgres reason (code/detail/constraint/column) sits on `.cause`. Passing the
 * error object lets us unwind that chain into the server log.
 */
export function clientError(errOrMsg: unknown): string {
  const msg = errOrMsg instanceof Error ? errOrMsg.message : String(errOrMsg);
  if (SAFE_PREFIXES.test(msg)) return msg;
  // Real cause stays in the server logs; never on the wire.
  console.error("[nbfc] unhandled route error:", msg);
  logCauseChain(errOrMsg);
  return "Something went wrong on our end. Please try again, or contact support if it persists.";
}

/**
 * Walk the `.cause` chain of a thrown value and log any Postgres error fields we
 * find. Drizzle wraps DB failures in a `DrizzleQueryError` whose `.cause` is the
 * driver error. Field names differ by driver — postgres.js uses
 * `constraint_name`/`table_name`/`column_name`/`schema_name`, node-postgres uses
 * `constraint`/`table`/`column`/`schema` — so we read both. These fields
 * pinpoint the failure (missing column, NOT-NULL/CHECK/FK violation, type
 * mismatch) that the wrapper's "Failed query: …" message hides.
 */
function logCauseChain(err: unknown): void {
  let cur: unknown = err;
  let depth = 0;
  while (cur instanceof Error && depth < 5) {
    const pg = cur as Error & Record<string, unknown>;
    const pick = (...keys: string[]) => {
      for (const k of keys) if (pg[k] != null) return pg[k];
      return undefined;
    };
    const fields = {
      message: pg.message,
      code: pick("code"),
      detail: pick("detail"),
      hint: pick("hint"),
      constraint: pick("constraint_name", "constraint"),
      column: pick("column_name", "column"),
      table: pick("table_name", "table"),
      schema: pick("schema_name", "schema"),
      where: pick("where"),
      routine: pick("routine"),
    };
    if (fields.code || fields.detail || fields.constraint || fields.column || fields.table) {
      console.error("[nbfc]   ↳ cause:", fields);
    } else if (depth > 0) {
      console.error("[nbfc]   ↳ cause:", pg.message);
    }
    cur = (cur as { cause?: unknown }).cause;
    depth += 1;
  }
}

/**
 * Turn a Zod failure into a `VALIDATION: …` string an operator can act on.
 *
 * The routes used to answer a rejected body with the bare word "VALIDATION"
 * and put the real reason in an `issues` array no client reads — so a
 * mistyped IFSC surfaced as an empty red toast with no field, no rule and
 * nothing to correct. The message names the field and the rule; `issues`
 * still rides along for anyone debugging.
 *
 * Only the first issue is spelled out. A form that fails two rules at once is
 * rare enough that a count is more useful than a wall of text.
 */
export function validationError(err: {
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>;
}): string {
  const [first, ...rest] = err.issues;
  if (!first) return "VALIDATION: the request body was rejected";
  const field = first.path.map(String).join(".");
  const where = field ? `${field} — ` : "";
  const more = rest.length ? ` (+${rest.length} more)` : "";
  return `VALIDATION: ${where}${first.message}${more}`;
}
