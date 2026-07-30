import { NextResponse, after } from "next/server";
import { requireSecurityAdmin } from "@/lib/security/route-guard";
import { resolveTarget } from "@/lib/security/target";
import { getScanFreshness } from "@/lib/security/scan-run";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Kick a security scan in the background (in-process). This only works on a host
 * where a real Chromium can launch — the dev machine or a VPS worker with
 * `npx playwright install chromium`. On Vercel serverless it cannot; use the CLI
 * (`npm run security:scan`) there.
 */
export async function POST() {
  const auth = await requireSecurityAdmin();
  if (!auth.ok) return auth.response;

  // Prod guard + target resolution (throws on prod without SECURITY_ALLOW_PROD=1).
  let target;
  try {
    target = resolveTarget();
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }

  // Friendly 409 if a scan for this env is already running (the DB lock is the
  // real guarantee; this is just a nicer message).
  const fresh = await getScanFreshness(target.env);
  if (fresh.in_flight) {
    return NextResponse.json({ ok: false, error: "A scan is already running." }, { status: 409 });
  }

  // Is a browser actually launchable here? If not, tell the caller to use the CLI.
  // Dynamic import so Playwright is never bundled into this route.
  try {
    const { chromium } = await import("@playwright/test");
    const exe = chromium.executablePath();
    if (!exe) throw new Error("no executable");
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "Chromium is not available on this host.",
        hint: "Run `npm run security:scan` on a machine with Playwright browsers, or `npx playwright install chromium` on the worker.",
      },
      { status: 501 },
    );
  }

  // Run detached — the response returns immediately; the dashboard polls status.
  after(async () => {
    try {
      const { runSecurityScan } = await import("@/lib/security/engine");
      await runSecurityScan({ trigger: "manual", actorUserId: auth.user.id });
    } catch (e) {
      console.error("[security] background scan failed:", e instanceof Error ? e.message : e);
    }
  });

  return NextResponse.json({ ok: true, started: true, env: target.env });
}
