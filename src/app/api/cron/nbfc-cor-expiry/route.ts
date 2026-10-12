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
import { isCronAuthorised } from "@/lib/cron-auth";
import { runAsJob } from "@/lib/runtime/liveSite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function runJob(req: NextRequest) {
  if (!isCronAuthorised(req)) {
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
  return runAsJob("cron:nbfc-cor-expiry", () => runJob(req));
}

export async function POST(req: NextRequest) {
  return runAsJob("cron:nbfc-cor-expiry", () => runJob(req));
}
