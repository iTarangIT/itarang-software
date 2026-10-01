/**
 * POST /api/nbfc/loans/refresh-dpd
 *
 * Manual trigger (Audit page) to age the EMI ledger and recompute
 * nbfc_loans.current_dpd. Delegates to runEmiAging(), which derives DPD from
 * emi_schedules — the single source of truth — superseding the old
 * loan_payments-based heuristic (which left the two ledgers drifting).
 *
 * The daily cron path is /api/cron/nbfc/run-emi-aging.
 */
import { NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { runEmiAging } from "@/lib/nbfc/servicing/runEmiAging";
import { guardApi } from "@/lib/auth/apiGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  // ID 118: signed in, with a role that reaches this screen.
  const authGate = await guardApi(["admin", "ceo", "nbfc_partner"]);
  if (!authGate.ok) return authGate.response;
  try {
    const result = await runEmiAging();
    return NextResponse.json({
      ok: true,
      // Back-compat: callers historically read `updated`.
      updated: result.dpd_updated + result.dpd_cleared,
      ...result,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: 500 });
  }
}
