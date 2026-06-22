/**
 * Daily cron — EMI aging + DPD unification.
 *
 * Ages the emi_schedules ledger (scheduled → overdue → missed) and recomputes
 * nbfc_loans.current_dpd from emi_schedules (replacing the old loan_payments
 * heuristic). Runs BEFORE the auto-debit cron so the due-selection sees fresh
 * statuses.
 *
 * Schedule: vercel.json "30 5 * * *". Auth: Vercel cron header OR
 * Bearer CRON_SECRET; unauthenticated allowed in non-production (repo pattern).
 */
import { NextRequest, NextResponse } from "next/server";
import { runEmiAging } from "@/lib/nbfc/servicing/runEmiAging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorised(req: NextRequest): boolean {
  if (req.headers.get("x-vercel-cron")) return true;
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (expected && auth === `Bearer ${expected}`) return true;
  if (process.env.NODE_ENV !== "production") return true;
  return false;
}

async function handle(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }
  try {
    const result = await runEmiAging();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[run-emi-aging] Error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
