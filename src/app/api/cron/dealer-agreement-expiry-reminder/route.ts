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
 * `Bearer CRON_SECRET`, else allows unauthenticated in non-production.
 */
import { NextRequest, NextResponse } from "next/server";
import { runAgreementExpiryReminders } from "@/lib/agreement/expiryReminder";
import { fromVercelCron } from "@/lib/security/cronAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorised(req: NextRequest): boolean {
  if (fromVercelCron(req)) return true;
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (expected && auth === `Bearer ${expected}`) return true;
  if (process.env.NODE_ENV !== "production") return true;
  return false;
}

async function run(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }

  const windowDays = Number(req.nextUrl.searchParams.get("windowDays")) || 2;
  return NextResponse.json(await runAgreementExpiryReminders({ windowDays }));
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
