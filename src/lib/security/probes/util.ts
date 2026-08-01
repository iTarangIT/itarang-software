/**
 * Shared helpers for probes: safe body reads, data/PII detection, ID harvesting.
 */
import type { APIRequestContext, APIResponse } from "@playwright/test";
import type { ProbeContext } from "../probe-context";
import { abs } from "../probe-context";

export interface Fetched {
  status: number;
  body: string;
  headers: Record<string, string>;
  contentType: string;
}

const TRANSIENT = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|Timeout .*exceeded/i;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A cold Next dev server (compiling a route on first hit, or briefly restarting)
 * drops connections intermittently — ECONNREFUSED/ECONNRESET/socket hang up. A
 * single transient drop must not fail a whole probe, so retry a few times with
 * backoff before giving up. Non-transient errors (real 4xx/5xx are returned as
 * responses, not thrown) propagate immediately.
 */
export async function rawGet(
  rc: APIRequestContext,
  url: string,
  opts: { maxRedirects?: number; timeout?: number } = {},
): Promise<APIResponse> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await rc.get(url, {
        maxRedirects: opts.maxRedirects ?? 0,
        failOnStatusCode: false,
        timeout: opts.timeout ?? 15_000,
      });
    } catch (e) {
      lastErr = e;
      if (!TRANSIENT.test((e as Error).message)) throw e;
      await sleep(400 * (attempt + 1));
    }
  }
  throw lastErr;
}

/** GET without following redirects; retries transient drops; never throws on non-2xx. */
export async function get(
  rc: APIRequestContext,
  baseUrl: string,
  path: string,
): Promise<Fetched> {
  const res = await rawGet(rc, abs(baseUrl, path));
  return read(res);
}

async function read(res: APIResponse): Promise<Fetched> {
  let body = "";
  try {
    body = (await res.text()).slice(0, 20_000);
  } catch {
    /* binary / empty */
  }
  const headers = res.headers();
  return { status: res.status(), body, headers, contentType: headers["content-type"] ?? "" };
}

/** A response that carries actual records, not an empty list or a redirect stub. */
export function looksLikeData(f: Fetched): boolean {
  if (f.status < 200 || f.status >= 300) return false;
  const b = f.body.trim();
  if (!b || b === "[]" || b === "{}" || b === "null") return false;
  // JSON array/object with content, or an HTML page (non-redirect).
  if (b.startsWith("[") || b.startsWith("{")) return b.length > 4;
  return b.length > 40;
}

// Indian-PII signals: PAN, GST, IFSC, Aadhaar-ish, long account numbers, phones.
const PII_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "PAN", re: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/ },
  { name: "GSTIN", re: /\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}\b/ },
  { name: "IFSC", re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/ },
  { name: "Aadhaar", re: /\b[2-9]{1}[0-9]{3}\s?[0-9]{4}\s?[0-9]{4}\b/ },
  { name: "bank account", re: /"(?:account|account_number|bank_account)[^"]*"\s*:\s*"?\d{9,18}/i },
  { name: "phone", re: /"(?:phone|mobile|contact)[^"]*"\s*:\s*"?(?:\+?91)?[6-9]\d{9}/i },
];

/** Which PII signals appear in a body (deduped). */
export function detectPii(body: string): string[] {
  const hits = new Set<string>();
  for (const p of PII_PATTERNS) if (p.re.test(body)) hits.add(p.name);
  return [...hits];
}

/**
 * Best-effort harvest of a real record id from any readable list endpoint, so
 * IDOR/ownership probes have a concrete target. Returns the first uuid-ish id
 * found, or null.
 */
export async function harvestId(ctx: ProbeContext): Promise<string | null> {
  const listEndpoints = ["/api/dealer-onboarding/list", "/api/dealer-onboarding/my", "/api/leads/summary"];
  const UUID = /"(?:id|application_id|applicationId|lead_id|leadId)"\s*:\s*"([0-9a-f-]{36})"/i;
  for (const ep of listEndpoints) {
    // Prefer an authed dealer read, fall back to anon.
    for (const rc of [ctx.api.get("dealer"), ctx.anon]) {
      if (!rc) continue;
      const f = await get(rc, ctx.baseUrl, ep);
      const m = f.body.match(UUID);
      if (m) {
        ctx.log(`harvested id ${m[1]} from ${ep}`);
        return m[1];
      }
    }
  }
  return null;
}
