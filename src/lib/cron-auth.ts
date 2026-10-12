// Strict CRON_SECRET enforcement. Previously each cron route did its own
// optional check (`if (CRON_SECRET && header !== ...)`) which exposed the
// route publicly when the env var was missing or empty — a deployment trap.
//
// This helper makes the wire contract explicit:
//   - CRON_SECRET unset → 500 (config error, deployment is broken)
//   - header missing/wrong → 401 (legitimate auth failure)
//   - header matches → null (proceed)

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { alertMissingSecret } from "@/lib/security/configAlert";
import { fromVercelCron } from "@/lib/security/cronAuth";

// Constant-time: a plain !== leaks how many leading characters matched.
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Boolean form for routes that shape their own 401 (tracker ID 130). Admits
 * Vercel's own scheduler or the exact `Bearer CRON_SECRET` — nothing else, in
 * every environment. CRON_SECRET unset fails CLOSED: poke a job locally with
 * the bearer from .env.local.
 */
export function isCronAuthorised(req: Request): boolean {
  if (fromVercelCron(req)) return true;
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    reportMissingCronSecret(req);
    return false;
  }
  return safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`);
}

/**
 * The NBFC Playwright bypass (`x-nbfc-test-bypass`): only with
 * NBFC_TEST_BYPASS=1, a configured secret, outside production, and a
 * constant-time match.
 */
export function isNbfcTestBypass(req: Request): boolean {
  const secret = process.env.NBFC_TEST_BYPASS_SECRET;
  if (process.env.NBFC_TEST_BYPASS !== "1" || !secret) return false;
  if (process.env.NODE_ENV === "production") return false;
  return safeEqual(req.headers.get("x-nbfc-test-bypass") ?? "", secret);
}

function reportMissingCronSecret(req: Request): void {
  const route = new URL(req.url).pathname;
  console.error(`[cron-auth] CRON_SECRET is not set — rejecting cron invocation on ${route}`);
  alertMissingSecret(route, "Scheduled job refused: CRON_SECRET is not set on the server.");
}

export function checkCronAuth(req: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    reportMissingCronSecret(req);
    return NextResponse.json(
      { error: "Cron secret not configured" },
      { status: 500 },
    );
  }
  const authHeader = req.headers.get("authorization");
  if (!safeEqual(authHeader ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
