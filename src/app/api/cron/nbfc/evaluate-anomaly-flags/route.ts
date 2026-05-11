/**
 * E-066 — Cron: re-evaluate anomaly flags after metric refresh (BRD §6.3.2)
 *
 * Mirrors the auth model of /api/cron/nbfc/compute-cds:
 *   - x-vercel-cron header (trusted Vercel cron trigger)
 *   - Bearer CRON_SECRET (manual / test runners)
 *   - Optional NBFC_TEST_BYPASS for Playwright runs
 *   - In non-production, unauthenticated triggers are accepted for parity
 *
 * Response: { ok, evaluated_count, flagged_count, cleared_count, run_at }
 */
import { NextRequest, NextResponse } from "next/server";
import { evaluateAnomalyFlags } from "@/lib/nbfc/anomalyFlags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorised(req: NextRequest): boolean {
  if (req.headers.get("x-vercel-cron")) return true;

  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (expected && auth === `Bearer ${expected}`) return true;

  if (
    process.env.NBFC_TEST_BYPASS === "1" &&
    process.env.NBFC_TEST_BYPASS_SECRET &&
    req.headers.get("x-nbfc-test-bypass") ===
      process.env.NBFC_TEST_BYPASS_SECRET
  ) {
    return true;
  }

  if (process.env.NODE_ENV !== "production") return true;

  return false;
}

async function handle(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json(
      { ok: false, error: "UNAUTHORIZED" },
      { status: 401 },
    );
  }

  try {
    const result = await evaluateAnomalyFlags();
    return NextResponse.json({
      ok: true,
      evaluated_count: result.evaluated_count,
      flagged_count: result.flagged.length,
      cleared_count: result.cleared.length,
      run_at: new Date().toISOString(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[cron/nbfc/evaluate-anomaly-flags] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
