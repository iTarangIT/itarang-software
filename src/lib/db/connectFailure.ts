/**
 * Did this error happen while OPENING a database connection — before any SQL
 * reached Postgres?
 *
 * WHY. The RDS instances have no pooler and a small connection cap, and a
 * busy minute on prod can make a new connection miss the 10 s
 * `connect_timeout` in db/index.ts. postgres.js then throws
 * `write CONNECT_TIMEOUT database-2.…rds.amazonaws.com:5432`, which the
 * dealer onboarding submit route used to show to the dealer word for word —
 * the DB hostname included — and the dealer had no idea pressing Submit again
 * would work.
 *
 * Every error matched here is raised before a statement runs (the connection
 * never opened, or Postgres refused it at login), so nothing was written and
 * the whole request is safe to repeat. Errors on a connection that WAS open
 * (a dropped socket mid-query, a statement timeout) are deliberately NOT
 * matched: the statement may have run, so repeating it is not safe to assume.
 *
 * Drizzle wraps driver errors and keeps the original on `.cause`, so the
 * whole cause chain is checked.
 */

/** postgres.js `code` values raised while connecting. */
const CONNECT_CODES = new Set([
  "CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  // Postgres SQLSTATEs that refuse a login before any statement runs.
  "53300", // too_many_connections
  "57P03", // cannot_connect_now (starting up / shutting down)
]);

export function isDbConnectFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current !== "object") return false;
    const e = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.code === "string" && CONNECT_CODES.has(e.code)) return true;
    if (typeof e.message === "string" && /\bCONNECT_TIMEOUT\b/.test(e.message)) {
      return true;
    }
    current = e.cause;
  }
  return false;
}

/** What a person sees instead of the driver's message. */
export const DB_BUSY_MESSAGE =
  "Our server is busy right now and could not save your application. Nothing was lost — please press Submit again in a few seconds.";
