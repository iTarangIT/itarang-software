/**
 * Hostinger Ecommerce API client — the ONLY module that reads HOSTINGER_*.
 *
 * Follows the src/lib/digio/client.ts convention: credentials are read through
 * lazy getters rather than module-load constants, so an unconfigured
 * environment fails at call time with a useful message instead of breaking
 * import of every module downstream.
 *
 * READ-ONLY BY CONSTRUCTION. This module exposes `hostingerGet` and nothing
 * else. There is deliberately no post/patch/delete helper: the create, update,
 * inventory and delete phases are separately gated, and each is blocked on an
 * unresolved API question (update method, price scale, delete semantics).
 * Do not add a mutation helper here without that approval.
 *
 * Verified 2026-08-23: base host from HOSTINGER_ECOMMERCE_API_URL, store-scoped
 * path prefix `/store/{storeId}`, Bearer auth. The `/v1/`, `/api/v1/` and
 * `/stores/` prefixes all 404.
 */

export function cleanEnv(value?: string) {
  return (value || "").trim().replace(/^["']|["']$/g, "");
}

export interface HostingerConfig {
  baseUrl: string;
  storeId: string;
  token: string;
  /**
   * Read but not yet used by any known endpoint. Phase 1 found no product
   * operation that consumes it, and `/sales-channel/{id}/products` 404s. It is
   * carried here so its purpose can be settled without touching callers.
   */
  salesChannelId: string | null;
}

const REQUIRED_VARS = [
  "HOSTINGER_ECOMMERCE_API_URL",
  "HOSTINGER_STORE_ID",
  "HOSTINGER_API_TOKEN",
] as const;

/**
 * Throws naming only the missing VARIABLE NAMES — never a value, so a
 * misconfiguration is diagnosable from logs without leaking the token.
 */
export function getHostingerConfig(): HostingerConfig {
  const baseUrl = cleanEnv(process.env.HOSTINGER_ECOMMERCE_API_URL).replace(/\/+$/, "");
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

  return { baseUrl, storeId, token, salesChannelId: salesChannelId || null };
}

/** A non-2xx response from Hostinger, carrying a CRM-facing HTTP status. */
export class HostingerApiError extends Error {
  readonly status: number;
  /** Hostinger's x-request-id, for vendor support tickets. */
  readonly requestId: string | null;

  constructor(message: string, status: number, requestId: string | null) {
    super(message);
    this.name = "HostingerApiError";
    this.status = status;
    this.requestId = requestId;
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Maps a vendor status onto the status the CRM should return. Hostinger's 401
 * means OUR token is bad, which is a server-side misconfiguration — surfacing
 * it as 401 to the browser would wrongly imply the CRM user is logged out.
 */
function toCrmStatus(vendorStatus: number): number {
  if (vendorStatus === 401 || vendorStatus === 403) return 502;
  if (vendorStatus === 404) return 404;
  if (vendorStatus === 429) return 429;
  if (vendorStatus >= 500) return 502;
  return 502;
}

export async function hostingerGet<T>(
  path: string,
  searchParams?: Record<string, string | number | undefined>,
): Promise<T> {
  const cfg = getHostingerConfig();
  const url = new URL(`${cfg.baseUrl}/store/${encodeURIComponent(cfg.storeId)}${path}`);
  for (const [k, v] of Object.entries(searchParams ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

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

  const requestId = res.headers.get("x-request-id");

  if (!res.ok) {
    // Body is read for the log line only. It is never forwarded to the browser:
    // the vendor's error envelope is unvalidated and could echo request detail.
    const body = await res.text().catch(() => "");
    console.error(
      `[hostinger] GET ${path} -> ${res.status}`,
      { requestId, body: body.slice(0, 500) },
    );
    throw new HostingerApiError(
      res.status === 404
        ? "Product not found in Hostinger"
        : `Hostinger returned ${res.status}`,
      toCrmStatus(res.status),
      requestId,
    );
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new HostingerApiError("Hostinger returned a malformed response", 502, requestId);
  }
}
