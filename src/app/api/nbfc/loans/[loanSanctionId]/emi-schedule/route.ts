/**
 * GET /api/nbfc/loans/[loanSanctionId]/emi-schedule
 *
 * Lists `emi_schedules` rows for a loan, ordered by due_date asc. Powers the
 * EMI History tab in the case-workspace drawer. Tenant-scoped through the
 * parent loan row (we resolve nbfc_loans.tenant_id first, then guard with
 * requireNbfcAccess).
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { db } from "@/lib/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { emiPaymentAttempts, emiSchedules, nbfcLoans } from "@/lib/db/schema";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ loanSanctionId: string }> },
) {
  try {
    const tenant = await getCurrentTenant();
    await requireNbfcAccess(tenant.id);

    const { loanSanctionId } = await ctx.params;
    if (!loanSanctionId) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: loanSanctionId required" },
        { status: 400 },
      );
    }

    const owner = await db
      .select({ tenant_id: nbfcLoans.tenant_id })
      .from(nbfcLoans)
      .where(
        and(
          eq(nbfcLoans.loan_application_id, loanSanctionId),
          eq(nbfcLoans.tenant_id, tenant.id),
        ),
      )
      .limit(1);
    if (owner.length === 0) {
      return NextResponse.json(
        { ok: false, error: "NOT_FOUND: loan not found for this tenant" },
        { status: 404 },
      );
    }

    const rows = await db
      .select({
        id: emiSchedules.id,
        emi_seq: emiSchedules.emi_seq,
        due_date: emiSchedules.due_date,
        paid_at: emiSchedules.paid_at,
        status: emiSchedules.status,
        days_overdue: emiSchedules.days_overdue,
        amount: emiSchedules.amount,
        amount_paid: emiSchedules.amount_paid,
        attempt_count: emiSchedules.attempt_count,
        payment_ref: emiSchedules.payment_ref,
        collection_mode: emiSchedules.collection_mode,
      })
      .from(emiSchedules)
      .where(eq(emiSchedules.loan_sanction_id, loanSanctionId))
      .orderBy(asc(emiSchedules.due_date));

    // Attach the collection attempt history (newest first), grouped per EMI.
    const attempts = await db
      .select({
        id: emiPaymentAttempts.id,
        emi_schedule_id: emiPaymentAttempts.emi_schedule_id,
        mode: emiPaymentAttempts.mode,
        channel: emiPaymentAttempts.channel,
        status: emiPaymentAttempts.status,
        amount_paise: emiPaymentAttempts.amount_paise,
        failure_reason: emiPaymentAttempts.failure_reason,
        reference_no: emiPaymentAttempts.reference_no,
        document_url: emiPaymentAttempts.document_url,
        collected_at: emiPaymentAttempts.collected_at,
        note: emiPaymentAttempts.note,
        created_at: emiPaymentAttempts.created_at,
      })
      .from(emiPaymentAttempts)
      .where(eq(emiPaymentAttempts.loan_sanction_id, loanSanctionId))
      .orderBy(desc(emiPaymentAttempts.created_at));

    const attemptsByEmi: Record<string, typeof attempts> = {};
    for (const a of attempts) {
      (attemptsByEmi[a.emi_schedule_id] ??= []).push(a);
    }

    const items = rows.map((r) => ({ ...r, attempts: attemptsByEmi[r.id] ?? [] }));

    return NextResponse.json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.includes("not allowed")
      ? 403
      : msg.startsWith("UNAUTHORIZED")
        ? 401
        : 500;
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status });
  }
}
