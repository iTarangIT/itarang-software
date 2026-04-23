import type { NextRequest } from "next/server";
import { log } from "@/lib/log";

/**
 * Central helper for computing the server's **public** origin when building
 * callback URLs handed to third parties (Decentro, Digio, QStash, etc.).
 *
 * Context — why this exists:
 * On 2026-04-23 a teammate ran `npm run dev` locally with `ngrok http 3000`
 * pointing at a free tunnel, initiated a DigiLocker / Aadhaar flow against
 * the shared sandbox DB, and Decentro stored the ngrok URL as the redirect
 * target. Tunnel died → customer completed Aadhaar → Decentro redirected
 * to the dead tunnel → ERR_NGROK_3200 landing page instead of our callback
 * handler. The existing `resolvePublicOrigin` in
 * `src/app/api/leads/digilocker/initiate/route.ts` trusted
 * `x-forwarded-host` unconditionally, which is how the ngrok host leaked
 * into the stored transaction.
 *
 * Precedence this helper applies (highest wins):
 *  1. `NEXT_PUBLIC_APP_URL` if set and passes safety validation.
 *  2. `VERCEL_URL` if set (Vercel preview/prod auto-injects).
 *  3. `x-forwarded-host` / `host` headers from the request IF the derived
 *     host passes safety validation.
 *
 * Safety validation:
 *  - In production/sandbox (`NODE_ENV === "production"`), reject any host
 *    matching `/ngrok-free\.dev|ngrok\.io|localhost|127\.0\.0\.1|\.local$/`.
 *    Call sites fall back to the next precedence option OR throw
 *    `PublicOriginError` if nothing valid remains.
 *  - Developers who deliberately need ngrok in dev/staging can set
 *    `ALLOW_UNSAFE_CALLBACK=1` to bypass the guard (escape hatch, not a
 *    default). We emit a `log.warn` on bypass so it shows up in logs.
 */

export class PublicOriginError extends Error {
  constructor(
    message: string,
    public code: "UNSAFE_HOST" | "NO_ORIGIN",
  ) {
    super(message);
    this.name = "PublicOriginError";
  }
}

const UNSAFE_HOST_PATTERNS: RegExp[] = [
  /ngrok-free\.dev$/i,
  /ngrok\.io$/i,
  /loca\.lt$/i,
  /^localhost(:\d+)?$/i,
  /^127\.0\.0\.1(:\d+)?$/i,
  /\.local(:\d+)?$/i,
];

function hostIsUnsafeForCallbacks(host: string): boolean {
  const h = host.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  return UNSAFE_HOST_PATTERNS.some((re) => re.test(h));
}

function normalizeUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/\/$/, "");
  if (!trimmed) return null;
  return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
}

function inProductionLike(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL === "1" ||
    process.env.NEXT_PUBLIC_APP_URL?.includes("sandbox.itarang.com") === true ||
    process.env.NEXT_PUBLIC_APP_URL?.includes("crm.itarang.com") === true
  );
}

function unsafeBypass(): boolean {
  return process.env.ALLOW_UNSAFE_CALLBACK === "1";
}

function extractHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function rejectOrReturn(url: string, source: string): string | null {
  const host = extractHost(url);
  if (!hostIsUnsafeForCallbacks(host)) return url;
  if (!inProductionLike() || unsafeBypass()) {
    if (unsafeBypass()) {
      log.warn(
        `[publicOrigin] accepting unsafe host ${host} from ${source} because ALLOW_UNSAFE_CALLBACK=1`,
      );
    }
    return url;
  }
  log.warn(
    `[publicOrigin] rejecting unsafe host ${host} from ${source} in production-like env`,
  );
  return null;
}

/**
 * Compute the public origin to use for outbound callback URLs.
 *
 * Pass a request when called from a route handler so header-derived fallback
 * is available. Background jobs without a request context should call
 * `publicOrigin({})` and rely on env configuration.
 *
 * Throws `PublicOriginError` if nothing valid can be produced — callers
 * should treat this as a hard failure (do NOT send a best-guess URL to
 * Decentro — that's how the incident happened).
 */
export function publicOrigin(opts: { req?: NextRequest } = {}): string {
  const sources: Array<{ label: string; url: string | null }> = [];

  const envAppUrl = normalizeUrl(process.env.NEXT_PUBLIC_APP_URL);
  if (envAppUrl) sources.push({ label: "NEXT_PUBLIC_APP_URL", url: envAppUrl });

  const vercelUrl = process.env.VERCEL_URL
    ? normalizeUrl(process.env.VERCEL_URL)
    : null;
  if (vercelUrl) sources.push({ label: "VERCEL_URL", url: vercelUrl });

  if (opts.req) {
    const headerHost =
      opts.req.headers.get("x-forwarded-host") || opts.req.headers.get("host");
    const headerProto =
      opts.req.headers.get("x-forwarded-proto") ||
      (headerHost && headerHost.startsWith("localhost") ? "http" : "https");
    if (headerHost) {
      sources.push({
        label: "request-header",
        url: `${headerProto || "https"}://${headerHost}`,
      });
    }
  }

  for (const source of sources) {
    if (!source.url) continue;
    const checked = rejectOrReturn(source.url, source.label);
    if (checked) return checked;
  }

  throw new PublicOriginError(
    "no safe public origin available — set NEXT_PUBLIC_APP_URL to the deployed URL (e.g. https://sandbox.itarang.com), or set ALLOW_UNSAFE_CALLBACK=1 only if you know the consequences",
    "NO_ORIGIN",
  );
}
