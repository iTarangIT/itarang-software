/**
 * Hostinger Ecommerce API client — the ONLY module that reads HOSTINGER_*.
 *
 * Targets the DOCUMENTED API at developers.hostinger.com/api/ecommerce/v1.
 * Phases 2-4 originally shipped against api-ecommerce.hostinger.com, an internal
 * surface with no published contract, no version prefix and no changelog; Phase
 * 4C migrated off it. Do not reintroduce that host.
 *
 * Follows the src/lib/digio/client.ts convention: credentials are read through a
 * lazy getter rather than module-load constants, so an unconfigured environment
 * fails at call time with a useful message instead of breaking import of every
 * module downstream.
 *
 * WRITE SURFACE (Phase 5, approved). Exposes `hostingerGet` and `hostingerWrite`.
 * `hostingerWrite` permits POST and PATCH only, for exactly these endpoints:
 *
 *   POST  /products/physical            create a physical product
 *   POST  /products/digital             create a digital product
 *   PATCH /products/{id}                name / description / status
 *   PATCH /products/{id}/variants/batch price (inventory is Phase 6)
 *
 * There is deliberately still NO DELETE helper — delete and the archive workflow
 * are Phase 7. Do not widen this surface without that approval.
 *
 * Writes are never retried. A timeout on a mutation is an UNKNOWN outcome, not a
 * failure, and a blind retry could create a second product.
 */

export function cleanEnv(value?: string) {
  return (value || "").trim().replace(/^["']|["']$/g, "");
}

/** Documented production API server (from the spec's `servers[]`). */
export const HOSTINGER_API_BASE = "https://developers.hostinger.com/api/ecommerce/v1";

export interface HostingerConfig {
  storeId: string;
  token: string;
  /**
   * Read but not sent. No documented product, variant or inventory operation
   * accepts a sales channel — it is a store-creation field. Carried here so its
   * purpose can be settled without touching callers.
   */
  salesChannelId: string | null;
}

const REQUIRED_VARS = ["HOSTINGER_STORE_ID", "HOSTINGER_API_TOKEN"] as const;

/**
 * Throws naming only the missing VARIABLE NAMES — never a value, so a
 * misconfiguration is diagnosable from logs without leaking the token.
 *
 * HOSTINGER_ECOMMERCE_API_URL is deliberately NOT required: it addressed the old
 * undocumented host and is unused since 4C. Requiring it would fail requests over
 * a value nothing reads.
 */
export function getHostingerConfig(): HostingerConfig {
  const storeId = cleanEnv(process.env.HOSTINGER_STORE_ID);
  const token = cleanEnv(process.env.HOSTINGER_API_TOKEN);
  const salesChannelId = cleanEnv(process.env.HOSTINGER_SALES_CHANNEL_ID);

  const missing = REQUIRED_VARS.filter((name) => !cleanEnv(process.env[name]));
  if (missing.length) {
    const err = new Error(
      `Hostinger Ecommerce is not configured — missing env var(s): ${missing.join(", ")}`,
    ) as Error & { status?: number };
    err.status = 503;
    throw err;
  }

  return { storeId, token, salesChannelId: salesChannelId || null };
}

/** A non-2xx response from Hostinger, carrying a CRM-facing HTTP status. */
export class HostingerApiError extends Error {
  readonly status: number;
  /** Hostinger's correlation id, for vendor support tickets. */
  readonly correlationId: string | null;

  constructor(message: string, status: number, correlationId: string | null) {
    super(message);
    this.name = "HostingerApiError";
    this.status = status;
    this.correlationId = correlationId;
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Maps a vendor status onto the status the CRM should return. Hostinger's 401
 * means OUR token is bad, which is a server-side misconfiguration — surfacing it
 * as 401 to the browser would wrongly imply the CRM user is logged out.
 */
function toCrmStatus(vendorStatus: number): number {
  if (vendorStatus === 404) return 404;
  if (vendorStatus === 429) return 429;
  // 422 describes the request WE built, so it is actionable for the operator and
  // is passed through with the vendor's field message (see hostingerWrite).
  if (vendorStatus === 422 || vendorStatus === 400) return 422;
  return 502;
}

/** Query values; arrays are serialised as repeated `key[]=` params. */
export type QueryValue = string | number | undefined | (string | number)[];

function buildUrl(path: string, params: Record<string, QueryValue> | undefined, storeId: string) {
  const url = new URL(`${HOSTINGER_API_BASE}/stores/${encodeURIComponent(storeId)}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      // The API expects repeated bracket params: include[]=variants&include[]=media
      for (const v of value) url.searchParams.append(`${key}[]`, String(v));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

export async function hostingerGet<T>(
  path: string,
  params?: Record<string, QueryValue>,
): Promise<T> {
  const cfg = getHostingerConfig();
  const url = buildUrl(path, params, cfg.storeId);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (e: unknown) {
    const reason = e instanceof Error && e.name === "TimeoutError" ? "timed out" : "failed";
    throw new HostingerApiError(`Hostinger request ${reason}`, 504, null);
  }

  if (!res.ok) {
    // Body is read for the log line only. It is never forwarded to the browser:
    // the vendor's error envelope is unvalidated and could echo request detail.
    const body = await res.text().catch(() => "");
    let correlationId: string | null = null;
    try {
      correlationId = (JSON.parse(body) as { correlation_id?: string }).correlation_id ?? null;
    } catch {
      /* non-JSON error body */
    }
    console.error(`[hostinger] GET ${path} -> ${res.status}`, {
      correlationId,
      body: body.slice(0, 500),
    });
    throw new HostingerApiError(
      res.status === 404 ? "Product not found in Hostinger" : `Hostinger returned ${res.status}`,
      toCrmStatus(res.status),
      correlationId,
    );
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new HostingerApiError("Hostinger returned a malformed response", 502, null);
  }
}

/**
 * POST / PATCH against the documented API. See the module header for the exact
 * set of permitted endpoints — this helper does not police the path, so keep
 * callers confined to `src/lib/hostinger/products.ts`.
 *
 * Never retried: a mutation timeout is an unknown outcome, and retrying could
 * create a duplicate product.
 */
export async function hostingerWrite<T>(
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
): Promise<T> {
  const cfg = getHostingerConfig();
  const url = buildUrl(path, undefined, cfg.storeId);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      body: JSON.stringify(body),
    });
  } catch (e: unknown) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    // Deliberately NOT "failed": the write may well have landed. Callers must
    // surface this as indeterminate rather than inviting a retry.
    throw new HostingerApiError(
      timedOut
        ? "Hostinger did not respond in time — the change may or may not have been applied. Refresh and check before retrying."
        : "Could not reach Hostinger — the change may or may not have been applied. Refresh and check before retrying.",
      504,
      null,
    );
  }

  const text = await res.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }

  if (!res.ok) {
    const envelope = parsed as { message?: string; correlation_id?: string } | null;
    const correlationId = envelope?.correlation_id ?? null;
    console.error(`[hostinger] ${method} ${path} -> ${res.status}`, {
      correlationId,
      body: text.slice(0, 500),
    });

    const crmStatus = toCrmStatus(res.status);
    // A 422 is a complaint about the payload we constructed — surfacing the
    // vendor's field message ("...prices.0.sale_amount must be an integer") is
    // what makes it fixable. Every other status keeps a generic message so no
    // unvalidated vendor text reaches the browser.
    const message =
      crmStatus === 422 && typeof envelope?.message === "string"
        ? envelope.message.slice(0, 300)
        : `Hostinger returned ${res.status}`;

    throw new HostingerApiError(message, crmStatus, correlationId);
  }

  return parsed as T;
}
