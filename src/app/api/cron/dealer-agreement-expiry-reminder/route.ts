/**
 * Daily cron: remind dealer-agreement signers who haven't signed yet that the
 * agreement is about to expire. The work lives in
 * src/lib/agreement/expiryReminder.ts (runAgreementExpiryReminders), which the
 * in-process hourly ticker (startAgreementExpiryReminderTicker) also runs —
 * Vercel crons do not fire on the PM2 boxes, so this route is the backstop and
 * the manual handle. `?windowDays=N` (default 2) widens the reminder window.
 *
 * Daily idempotency is in the runner (a `dealer_agreement_events`
 * 'expiry_reminder' row per signer per send, skipped for ~20h), so the route
 * and the ticker together send at most once a day.
 *
 * Auth: trusts the Vercel cron header (`x-vercel-cron`), else a
 * `Bearer CRON_SECRET` (checkCronAuth rules — closed when the secret is unset).
 */
import { NextRequest, NextResponse } from "next/server";
import { runAgreementExpiryReminders } from "@/lib/agreement/expiryReminder";
import { isCronAuthorised } from "@/lib/cron-auth";
import { runAsJob } from "@/lib/runtime/liveSite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function run(req: NextRequest) {
  if (!isCronAuthorised(req)) {
    return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }

  const windowDays = Number(req.nextUrl.searchParams.get("windowDays")) || 2;
  return NextResponse.json(await runAgreementExpiryReminders({ windowDays }));
}

export async function GET(req: NextRequest) {
  return runAsJob("cron:agreement-expiry-reminder", () => run(req));
}
export async function POST(req: NextRequest) {
  return runAsJob("cron:agreement-expiry-reminder", () => run(req));
}
