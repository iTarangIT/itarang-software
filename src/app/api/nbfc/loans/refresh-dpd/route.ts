/**
 * POST /api/nbfc/loans/refresh-dpd
 *
 * Recomputes nbfc_loans.current_dpd from the loan_payments table.
 * Intended to be hit by:
 *   - Vercel cron (nightly): vercel.json schedule "0 2 * * *"
 *   - Manual trigger from the Audit page (Phase D2)
 *
 * The DPD calculation here is a simple heuristic for the demo:
 *   - For each loan_application_id, find the latest payment_due_date
 *     in loan_payments where status != 'paid'
 *   - DPD = days(now - that date) clamped to [0, 720]
 *
 * Replace with your real DPD logic (typically computed by your collections
 * system) before going to production. The schema and shape stay the same.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { nbfcLoans } from "@/lib/db/schema";
import { sql } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    // Phase A heuristic: best-effort DPD update from loan_payments. We only
    // touch rows where the heuristic produces a value; others stay as-is.
    // Wrapped in a transaction so the count is consistent.
    const result = await db.execute(sql`
      WITH latest_unpaid AS (
        SELECT
          lp.loan_application_id,
          MAX(GREATEST(0,
            EXTRACT(EPOCH FROM (NOW() - lp.payment_due_date))::int / 86400
          ))::int AS days_overdue
        FROM loan_payments lp
        WHERE lp.status IS DISTINCT FROM 'paid'
        GROUP BY lp.loan_application_id
      )
      UPDATE ${nbfcLoans} nl
      SET current_dpd = LEAST(720, GREATEST(0, lu.days_overdue)),
          updated_at  = NOW()
      FROM latest_unpaid lu
      WHERE nl.loan_application_id = lu.loan_application_id
      RETURNING nl.loan_application_id
    `);

    const updated = (result as unknown as { length?: number; rowCount?: number; rows?: unknown[] })
      .rowCount ??
      (result as unknown as { length?: number; rows?: unknown[] }).rows?.length ??
      0;

    return NextResponse.json({ ok: true, updated });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
