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

// Constant-time: a plain !== leaks how many leading characters matched.
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export function checkCronAuth(req: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    const route = new URL(req.url).pathname;
    console.error(
      `[cron-auth] CRON_SECRET is not set — rejecting cron invocation on ${route}`,
    );
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
