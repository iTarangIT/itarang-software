// Scraper-scoped retry helper. Kept here (not in lib/) on purpose: other callers
// will want jitter/circuit-breakers/idempotency keys we don't need yet — premature
// generalization. Lift when a second caller materializes.

export interface RetryableHttpError extends Error {
  status?: number;
  retryAfterMs?: number;
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  label: string;
  // Return true to retry with default backoff, an object to override the wait,
  // or false to give up. If omitted, the default policy retries on 429+5xx and
  // honors Retry-After (capped at 5s).
  isRetryable?: (err: unknown) => boolean | { retryAfterMs: number };
}

// 4xx (except 429) are configuration bugs — retrying just wastes the 60s chunk
// budget. 429 and 5xx are the legitimate transient cases.
const RETRY_AFTER_CEILING_MS = 5_000;

function defaultIsRetryable(err: unknown): boolean | { retryAfterMs: number } {
  const e = err as RetryableHttpError;
  if (e?.status === 429) {
    const wait = Math.min(e.retryAfterMs ?? 0, RETRY_AFTER_CEILING_MS);
    return wait > 0 ? { retryAfterMs: wait } : true;
  }
  if (typeof e?.status === "number" && e.status >= 500 && e.status < 600) {
    return true;
  }
  return false;
}

export async function retryFetch<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const { attempts, baseDelayMs, label } = opts;
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts) break;

      const verdict = isRetryable(err);
      if (!verdict) break;

      const waitMs =
        typeof verdict === "object"
          ? verdict.retryAfterMs
          : baseDelayMs * attempt;

      console.warn(
        `[retry][${label}] attempt ${attempt} failed (${(err as Error)?.message ?? err}), retrying in ${waitMs}ms`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

// Parse `Retry-After` header — supports both delta-seconds and HTTP-date forms.
// Returns milliseconds, or 0 if unparseable / in the past.
export function parseRetryAfter(header: string | null): number {
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return 0;
}
