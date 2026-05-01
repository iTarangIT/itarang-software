/**
 * E-006 — Daily cron: scan NBFCs whose CoR expires within the next 60
 * days, insert idempotency rows into `nbfc_cor_expiry_alerts`, and
 * notify admin recipients (ceo, business_head, admin) once per pair.
 *
 * Schedule: daily at 00:30 UTC (≈ 06:00 IST). Configured via vercel.json.
 *
 * Auth model: this route trusts the Vercel cron header
 * (`x-vercel-cron`) when present; otherwise it accepts a bearer token in
 * `authorization: Bearer <CRON_SECRET>`. The same idempotency guard runs
 * inside the job, so accidental double-firing is harmless.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkNbfcCorExpiryJob } from "@/lib/queue/jobs/checkNbfcCorExpiryJob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorised(req: NextRequest): boolean {
  // Vercel cron sets this header automatically.
  if (req.headers.get("x-vercel-cron")) return true;

  // Manual / Playwright invocation: accept Bearer or no auth in non-prod.
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (expected && auth === `Bearer ${expected}`) return true;

  // In non-production we allow unauthenticated triggers (mirrors other
  // cron routes in this repo) so dev tooling and tests can run the job.
  if (process.env.NODE_ENV !== "production") return true;

  return false;
}

async function runJob(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json(
      { ok: false, error: "UNAUTHORIZED" },
      { status: 401 },
    );
  }

  const url = new URL(req.url);
  const windowDaysParam = url.searchParams.get("windowDays");
  const windowDays = windowDaysParam ? Number(windowDaysParam) : 60;
  if (!Number.isFinite(windowDays) || windowDays <= 0 || windowDays > 180) {
    return NextResponse.json(
      { ok: false, error: "BAD_REQUEST: windowDays must be 1..180" },
      { status: 400 },
    );
  }

  try {
    const result = await checkNbfcCorExpiryJob({ windowDays });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.error("[cron/nbfc-cor-expiry] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return runJob(req);
}

export async function POST(req: NextRequest) {
  return runJob(req);
}
