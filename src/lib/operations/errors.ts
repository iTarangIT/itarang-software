/**
 * Turning a wrapped driver error into something a human can act on.
 *
 * Drizzle wraps every query failure as `Failed query: <the entire SQL>\nparams:`
 * and hangs the real cause — ECONNREFUSED, `relation "x" does not exist`, a
 * column typo — on `.cause`. Rendering the wrapper puts a multi-line SQL dump
 * in the one-line cell where a reason belongs, and the actual reason is the
 * part that got truncated away.
 *
 * The Ops Console shows collector errors on /operations/jobs and inline on
 * every module page, so this matters more here than it would elsewhere: the
 * error text IS the product in a monitoring tool.
 *
 * Same cause-chain walk as isUniqueViolation() in ./runner.ts, for the same
 * underlying reason — what matters is never on the top-level object.
 */

/** Depth guard: a cycle in a cause chain must not hang the collector. */
const MAX_DEPTH = 5;

export function rootCauseMessage(e: unknown, max = 200): string {
  let best = e instanceof Error ? e.message : String(e);

  for (let err: unknown = e, depth = 0; err != null && depth < MAX_DEPTH; depth++) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) best = cause.message;
    else if (typeof cause === "string" && cause) best = cause;
    err = cause;
  }

  // Collapse newlines: this lands in a badge and a one-line table cell.
  return best.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Prefixed form for a sample's value_text, e.g. "unavailable: relation …". */
export function unavailableText(e: unknown, prefix = "unavailable"): string {
  return `${prefix}: ${rootCauseMessage(e)}`;
}
