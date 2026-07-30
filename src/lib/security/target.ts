/**
 * Resolve + guard the scan target.
 *
 * The scanner actively probes (auth-bypass attempts, IDOR, uploads), so it must
 * only ever point at a system we own and are cleared to test. Production
 * (crm.itarang.com) is refused unless SECURITY_ALLOW_PROD=1 — the same shape as
 * the e2e suite's prod guard in tests/e2e/global.setup.ts.
 */
import type { ScanMode, TargetEnv } from "./types";

export interface ResolvedTarget {
  baseUrl: string;
  env: TargetEnv;
}

const PROD_HOST = /(^|\.)crm\.itarang\.com$/i;
const SANDBOX_HOST = /(^|\.)sandbox\.itarang\.com$/i;

/**
 * Classify a base URL into an environment and enforce the prod guard.
 * `rawUrl` overrides SECURITY_SCAN_BASE_URL (default http://localhost:3000).
 */
export function resolveTarget(rawUrl?: string): ResolvedTarget {
  const baseUrl = (rawUrl ?? process.env.SECURITY_SCAN_BASE_URL ?? "http://localhost:3000")
    .trim()
    .replace(/\/+$/, "");

  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    throw new Error(`[security] Invalid scan target URL: "${baseUrl}"`);
  }

  const env: TargetEnv = PROD_HOST.test(host)
    ? "prod"
    : SANDBOX_HOST.test(host)
      ? "sandbox"
      : "local";

  if (env === "prod" && process.env.SECURITY_ALLOW_PROD !== "1") {
    throw new Error(
      `[security] Target "${baseUrl}" is production but SECURITY_ALLOW_PROD=1 is not set. Refusing to scan.`,
    );
  }

  return { baseUrl, env };
}

export function resolveMode(rawMode?: string): ScanMode {
  const m = (rawMode ?? process.env.SECURITY_SCAN_MODE ?? "safe").toLowerCase();
  return m === "aggressive" ? "aggressive" : "safe";
}
