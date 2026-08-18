/**
 * Browser-side fetch helpers for the auction APIs.
 *
 * WHY TWO OF THEM
 *   The auction feature answers in three different envelopes, and every screen
 *   that talks to more than one of them has so far re-implemented the
 *   difference by hand:
 *
 *     NBFC routes      { ok: true,  ...payload }        { ok: false, error: string }
 *     dealer routes    { success: true, data: T }       { success: false, error: { message } }
 *     GET /nbfc/auction/lots — the payload BARE, with no `ok` key at all
 *
 *   That third one is not a typo: `lots/route.ts` returns the ListLotsResult
 *   directly, which is why the old marketplace page reads `body.items` while
 *   checking `res.ok`. `nbfcFetch` handles it by treating a missing `ok` on a
 *   2xx response as success, so callers do not have to know which routes are
 *   which.
 *
 * WHAT THEY GUARANTEE
 *   A rejected promise whose `message` is safe to hand to `toast.error()`.
 *   Server error strings arrive prefixed (`BAD_REQUEST: …`, `CONFLICT: …`)
 *   because the prefix is how the routes pick a status code; the prefix is
 *   stripped here so a bidder is not shown `CONFLICT:` in a toast.
 */

/** Strips the `KIND: ` prefix the services use to carry a status code. */
function humanise(message: string): string {
  return message.replace(/^[A-Z_]+:\s*/, "").trim() || message;
}

export class AuctionApiError extends Error {
  readonly status: number;
  /** Zod issues, when the route rejected the body. */
  readonly issues?: unknown;

  constructor(message: string, status: number, issues?: unknown) {
    super(message);
    this.name = "AuctionApiError";
    this.status = status;
    this.issues = issues;
  }
}

async function readBody(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    // A 502 from the proxy, or a route that threw before it could serialise.
    // "Unexpected end of JSON input" is not a useful thing to show a user.
    return {};
  }
}

/**
 * NBFC-side routes: `{ ok, error }`, or a bare payload on the one legacy route.
 */
export async function nbfcFetch<T>(
  input: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = await readBody(res);

  if (!res.ok || body.ok === false) {
    const raw =
      typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new AuctionApiError(humanise(raw), res.status, body.issues);
  }

  return body as T;
}

/** Dealer-side routes: `{ success, data, error: { message } }`. */
export async function dealerFetch<T>(
  input: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = await readBody(res);

  if (!res.ok || body.success === false) {
    const err = body.error as { message?: string } | undefined;
    throw new AuctionApiError(
      humanise(err?.message ?? `HTTP ${res.status}`),
      res.status,
      body.issues,
    );
  }

  return body.data as T;
}

/** ₹1,84,000 — Indian grouping, no paise. */
export function formatINR(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
}
