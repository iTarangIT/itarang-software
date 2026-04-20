// Strips raw SQL / Postgres-driver internals out of errors before they reach
// the UI or get persisted to scrape_runs.error_message. Keeps the real error
// in server logs while surfacing a clean message to the user.
//
// Examples it catches:
//   "Failed query: insert into \"scraper_leads_duplicates\" ($1, $2, ...)"
//   "duplicate key value violates unique constraint \"...\""
//   "ETIMEDOUT"
//   AggregateError JSON blobs from postgres-js
export function sanitizeDbError(err: unknown): string {
  if (!err) return "Unknown error";

  // Postgres-js attaches the useful bits in `code` + `detail`. Prefer those
  // over `message` which contains the full SQL.
  const e = err as {
    code?: string;
    detail?: string;
    constraint?: string;
    message?: string;
    name?: string;
  };

  // Known Postgres SQLSTATE codes → friendly labels.
  const codeMap: Record<string, string> = {
    "23505": "Duplicate record",
    "23503": "Referenced record missing",
    "23502": "Required field missing",
    "22001": "Value too long for field",
    "22P02": "Invalid value for field",
    "54000": "Data too large — try a smaller batch",
    "57014": "Query timed out",
    "53300": "Database connection limit reached",
    "40P01": "Database deadlock — retry",
    "08006": "Database connection failure",
    "08003": "Database connection lost",
  };

  if (e.code && codeMap[e.code]) {
    return codeMap[e.code];
  }

  const raw = e.message ?? String(err);

  // The postgres-js driver prefixes errors with "Failed query: <SQL>" — strip it.
  if (/^failed query:/i.test(raw)) {
    return "Database write failed — check server logs for details";
  }

  // Strip parenthesised parameter lists ($1, $2, ...) — usually noise.
  if (raw.includes("$1") && raw.length > 200) {
    return "Database write failed — check server logs for details";
  }

  // Network / driver errors
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED/.test(raw)) {
    return "Database temporarily unavailable — please retry";
  }

  // Cap length so we never splat a huge blob into the UI.
  return raw.length > 240 ? raw.slice(0, 240) + "…" : raw;
}
